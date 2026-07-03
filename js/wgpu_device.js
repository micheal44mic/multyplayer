// DEVICE WEBGPU CONDIVISO (fase 2.2 del piano, docs/webgpu-engine-plan.md).
// Un solo GPUDevice per tutta l'app: il ponte del tratto (wgpu_stroke) e il
// present (renderer_wgpu) devono stare sullo stesso device perché il renderer
// legge l'arena del ponte con copyBufferToTexture — due device non si parlano.
// La richiesta è un singleton idempotente; la perdita del device (Android in
// background, TDR) viene notificata a tutti i consumatori registrati, che si
// marcano inutilizzabili e lasciano l'app ripiegare su worker/main.

/** @type {Promise<any>|null} */
let devicePromise = null;
/** @type {Set<(info: any) => void>} */
const lostCbs = new Set();

/** Il device condiviso, o null se WebGPU non c'è / l'init fallisce. */
export function acquireWgpuDevice() {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    const gpu = /** @type {any} */ (navigator).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      device.lost.then((/** @type {any} */ info) => {
        console.warn('[wgpu_device] device perso:', info && info.reason, info && info.message);
        for (const cb of lostCbs) {
          try { cb(info); } catch { /* un consumatore rotto non blocca gli altri */ }
        }
      });
      return device;
    } catch (err) {
      console.warn('[wgpu_device] requestDevice fallita:', err);
      return null;
    }
  })();
  return devicePromise;
}

/** Notifica alla perdita del device. @param {(info: any) => void} cb */
export function onWgpuDeviceLost(cb) { lostCbs.add(cb); }
