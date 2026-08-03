// Product catalog for the demo store (server-side source of truth).
// Prices are in MINOR units (cents). Mirrors the hyperswitch-prism demo store.

export interface Product {
  id: string;
  name: string;
  description: string;
  priceUSD: number;
  priceEUR: number;
  image: string;
}

export const PRODUCTS: Product[] = [
  { id: '1', name: 'Wireless Headphones', description: 'Premium noise-canceling Bluetooth headphones', priceUSD: 1999, priceEUR: 1849, image: '🎧' },
  { id: '2', name: 'Smart Watch', description: 'Fitness tracking with heart rate monitor', priceUSD: 2999, priceEUR: 2799, image: '⌚' },
  { id: '3', name: 'Laptop Stand', description: 'Ergonomic aluminum laptop stand', priceUSD: 499, priceEUR: 459, image: '💻' },
  { id: '4', name: 'Wireless Charger', description: 'Fast wireless charging pad', priceUSD: 399, priceEUR: 369, image: '🔋' },
  { id: '5', name: 'USB-C Hub', description: '7-in-1 multiport adapter', priceUSD: 599, priceEUR: 549, image: '🔌' },
  { id: '6', name: 'Mechanical Keyboard', description: 'RGB backlit gaming keyboard', priceUSD: 899, priceEUR: 829, image: '⌨️' },
];
