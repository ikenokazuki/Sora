// ブラウザの枠の部品は、共有の外部資源にも使うので、security/fair_queue.ts に移した（設計 6。穴 25）。これまでの import 先を保つ
export { type Lease, type QueuePolicy, type SemaphoreOptions, SimpleSemaphore } from './security/fair_queue.js';
