/**
 * Storefront: catalog + cart. Products come from /api/store/products (server is the
 * single source of truth); cart lives in localStorage. Checkout hands off to
 * /store/checkout, where the request-level payment config lives.
 */

let products = [];
let cart = [];
let currency = 'USD';

const productsGrid = document.getElementById('products-grid');
const currencySelector = document.getElementById('currency-selector');
const cartBtn = document.getElementById('cart-btn');
const cartCount = document.getElementById('cart-count');
const cartSidebar = document.getElementById('cart-sidebar');
const cartOverlay = document.getElementById('cart-overlay');
const closeCartBtn = document.getElementById('close-cart');
const cartItems = document.getElementById('cart-items');
const cartTotalAmount = document.getElementById('cart-total-amount');
const checkoutBtn = document.getElementById('checkout-btn');

document.addEventListener('DOMContentLoaded', async () => {
  loadCartFromStorage();
  await loadProducts();
  renderProducts();
  renderCart();
  setupEventListeners();
});

async function loadProducts() {
  try {
    const res = await fetch('/api/store/products');
    const data = await res.json();
    products = data.products || [];
  } catch (e) {
    console.error('[Store] Failed to load products:', e);
    productsGrid.innerHTML = '<p>Failed to load products.</p>';
  }
}

function setupEventListeners() {
  currencySelector.addEventListener('change', (e) => {
    currency = e.target.value;
    renderProducts();
    renderCart();
    saveCartToStorage();
  });
  cartBtn.addEventListener('click', openCart);
  closeCartBtn.addEventListener('click', closeCart);
  cartOverlay.addEventListener('click', closeCart);
  checkoutBtn.addEventListener('click', goToCheckout);
}

function renderProducts() {
  productsGrid.innerHTML = products.map((product) => {
    const price = currency === 'EUR' ? product.priceEUR : product.priceUSD;
    return `
      <div class="product-card">
        <div class="product-image">${escapeHtml(product.image)}</div>
        <div class="product-info">
          <h3 class="product-name">${escapeHtml(product.name)}</h3>
          <p class="product-description">${escapeHtml(product.description)}</p>
          <p class="product-price">${formatPrice(price, currency)}</p>
          <button class="add-to-cart-btn" onclick="addToCart('${escapeHtml(product.id)}')">Add to Cart</button>
        </div>
      </div>
    `;
  }).join('');
}

function addToCart(productId) {
  const product = products.find((p) => p.id === productId);
  if (!product) return;

  const existing = cart.find((item) => item.product.id === productId && item.currency === currency);
  if (existing) {
    existing.quantity++;
  } else {
    cart.push({ product, quantity: 1, currency });
  }
  saveCartToStorage();
  renderCart();

  const btn = event.target;
  btn.textContent = 'Added!';
  btn.classList.add('added');
  setTimeout(() => {
    btn.textContent = 'Add to Cart';
    btn.classList.remove('added');
  }, 1000);
}

function removeFromCart(productId) {
  cart = cart.filter((item) => !(item.product.id === productId && item.currency === currency));
  saveCartToStorage();
  renderCart();
}

function updateQuantity(productId, delta) {
  const item = cart.find((i) => i.product.id === productId && i.currency === currency);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) {
    removeFromCart(productId);
  } else {
    saveCartToStorage();
    renderCart();
  }
}

function renderCart() {
  const cartForCurrency = cart.filter((item) => item.currency === currency);

  if (cartForCurrency.length === 0) {
    cartItems.innerHTML = `
      <div class="empty-cart">
        <div class="empty-cart-icon">🛒</div>
        <p>Your cart is empty</p>
      </div>`;
    cartTotalAmount.textContent = formatPrice(0, currency);
    checkoutBtn.disabled = true;
    cartCount.textContent = '0';
    return;
  }

  const totalItems = cartForCurrency.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = cartForCurrency.reduce((sum, item) => {
    const price = currency === 'EUR' ? item.product.priceEUR : item.product.priceUSD;
    return sum + price * item.quantity;
  }, 0);

  cartItems.innerHTML = cartForCurrency.map((item) => {
    const price = currency === 'EUR' ? item.product.priceEUR : item.product.priceUSD;
    return `
      <div class="cart-item">
        <div class="cart-item-image">${escapeHtml(item.product.image)}</div>
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(item.product.name)}</div>
          <div class="cart-item-price">${formatPrice(price, currency)}</div>
        </div>
        <div class="cart-item-quantity">
          <button class="qty-btn" onclick="updateQuantity('${escapeHtml(item.product.id)}', -1)">-</button>
          <span>${escapeHtml(item.quantity)}</span>
          <button class="qty-btn" onclick="updateQuantity('${escapeHtml(item.product.id)}', 1)">+</button>
        </div>
      </div>`;
  }).join('');

  cartTotalAmount.textContent = formatPrice(totalAmount, currency);
  cartCount.textContent = totalItems;
  checkoutBtn.disabled = false;
}

function openCart() {
  cartSidebar.classList.add('open');
  cartSidebar.classList.remove('hidden');
  cartOverlay.classList.add('open');
  cartOverlay.classList.remove('hidden');
}

function closeCart() {
  cartSidebar.classList.remove('open');
  cartSidebar.classList.add('hidden');
  cartOverlay.classList.remove('open');
  cartOverlay.classList.add('hidden');
}

function goToCheckout() {
  const cartForCurrency = cart.filter((item) => item.currency === currency);
  const totalAmount = cartForCurrency.reduce((sum, item) => {
    const price = currency === 'EUR' ? item.product.priceEUR : item.product.priceUSD;
    return sum + price * item.quantity;
  }, 0);

  localStorage.setItem('checkoutData', JSON.stringify({ items: cartForCurrency, currency, totalAmount }));
  window.location.href = '/store/checkout';
}

function formatPrice(amount, curr) {
  const symbol = curr === 'EUR' ? '€' : '$';
  return `${symbol}${(amount / 100).toFixed(2)}`;
}

function saveCartToStorage() {
  localStorage.setItem('cart', JSON.stringify(cart));
  localStorage.setItem('currency', currency);
}

function loadCartFromStorage() {
  const savedCart = localStorage.getItem('cart');
  const savedCurrency = localStorage.getItem('currency');
  if (savedCart) cart = JSON.parse(savedCart);
  if (savedCurrency) {
    currency = savedCurrency;
    currencySelector.value = currency;
  }
}

// Escape dynamic values before inserting into innerHTML (cart data comes from
// localStorage, so treat it as untrusted).
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addToCart = addToCart;
window.removeFromCart = removeFromCart;
window.updateQuantity = updateQuantity;
