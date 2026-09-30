import { createApp } from '../src/app.js';

export const HOUR = 3_600_000;

/** An app with a controllable clock, a regular customer c1, a staff customer s1, and a slot starting in 100h. */
export function world(start = 10 * HOUR) {
  let t = start;
  const app = createApp({ clock: { now: () => t } });
  app.customers.register({ id: 'c1', name: 'Casey' }, 'test');
  app.customers.register({ id: 'c2', name: 'Robin' }, 'test');
  app.customers.register({ id: 's1', name: 'Sam', kind: 'staff' }, 'test');
  app.slots.create({ id: 'slot-a', startsAt: start + 100 * HOUR, basePrice: 5000, minimumPrice: 2000 });
  return { ...app, tick: (ms = 1_000) => { t += ms; }, at: (ms: number) => { t = ms; } };
}
