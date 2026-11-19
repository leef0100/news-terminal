// Placeholder until this module is built.
import { Router } from 'express';
export function createVoices() {
  const router = Router();
  router.use((_req, res) => res.status(503).json({ error: 'Not built yet' }));
  return { router, health: () => ({ sources: [] }), stop() {} };
}
