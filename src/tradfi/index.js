// Placeholder until the stocks, calendar and private-markets module is built.
import { Router } from 'express';
export function createTradfi() {
  const router = Router();
  router.use((_req, res) => res.status(503).json({ error: 'Not built yet' }));
  return { router, health: () => ({ sources: [] }), stop() {} };
}
