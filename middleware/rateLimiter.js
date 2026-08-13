/**
 * rateLimiter.js
 * Protección anti-DDoS de 3 capas — todo en memoria (ultra-rápido)
 * 
 * CAPA 1: Blacklist rápida (Map en memoria)
 * CAPA 2: Rate limiting por ventana de tiempo (sliding window)
 * CAPA 3: Limpieza periódica automática
 */

// ── Configuración ─────────────────────────────────────────────────────────────
const MAX_REQUESTS = 30;              // Máximo de requests permitidos...
const WINDOW_SECONDS = 60;            // ...en esta ventana de tiempo
const BLOCK_DURATION_MS = 3600 * 1000; // Bloqueo por 1 hora (en ms)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Limpiar cada 5 minutos

// ── Almacenamiento en memoria ─────────────────────────────────────────────────

// Blacklist: Map<ip, { blockedAt, expiresAt, reason }>
const blacklist = new Map();

// Rate tracking: Map<ip, [timestamp1, timestamp2, ...]>
const requestLog = new Map();

// ── Obtener IP real del cliente ───────────────────────────────────────────────
function getClientIP(req) {
  // Cloudflare
  const cfIP = req.headers['cf-connecting-ip'];
  if (cfIP && isValidPublicIP(cfIP)) return cfIP.trim();

  // X-Forwarded-For (tomar la primera IP = cliente original)
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const firstIP = xff.split(',')[0].trim();
    if (isValidPublicIP(firstIP)) return firstIP;
  }

  // X-Real-IP (Nginx reverse proxy)
  const xri = req.headers['x-real-ip'];
  if (xri && isValidPublicIP(xri)) return xri.trim();

  // Directo
  return req.socket.remoteAddress || req.ip || '0.0.0.0';
}

function isValidPublicIP(ip) {
  if (!ip) return false;
  // Aceptar cualquier IP válida (en producción, podrías filtrar privadas)
  return /^[\d.:a-fA-F]+$/.test(ip.trim());
}

// ── CAPA 1: Blacklist ─────────────────────────────────────────────────────────

function isBlacklisted(ip) {
  const entry = blacklist.get(ip);
  if (!entry) return false;

  // Verificar si expiró
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    blacklist.delete(ip);
    return false;
  }
  return true;
}

function addToBlacklist(ip, durationMs, reason = 'rate_limit_exceeded') {
  blacklist.set(ip, {
    blockedAt: Date.now(),
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0, // 0 = permanente
    reason
  });
}

function removeFromBlacklist(ip) {
  blacklist.delete(ip);
}

function getBlacklistedIPs() {
  const now = Date.now();
  const result = [];
  for (const [ip, entry] of blacklist) {
    // Solo incluir activas
    if (!entry.expiresAt || entry.expiresAt > now || entry.expiresAt === 0) {
      result.push({
        ip,
        reason: entry.reason,
        blocked_at: new Date(entry.blockedAt).toISOString(),
        expires_at: entry.expiresAt > 0 ? new Date(entry.expiresAt).toISOString() : null
      });
    }
  }
  return result;
}

// ── CAPA 2: Rate Limiting ─────────────────────────────────────────────────────

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;

  // Obtener o crear el log de timestamps para esta IP
  let timestamps = requestLog.get(ip);
  if (!timestamps) {
    timestamps = [];
    requestLog.set(ip, timestamps);
  }

  // Filtrar timestamps fuera de la ventana
  const cutoff = now - windowMs;
  const filtered = timestamps.filter(t => t > cutoff);
  filtered.push(now);
  requestLog.set(ip, filtered);

  return filtered.length;
}

// ── CAPA 3: Limpieza periódica ────────────────────────────────────────────────

function periodicCleanup() {
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;
  const cutoff = now - windowMs;

  // Limpiar rate log
  for (const [ip, timestamps] of requestLog) {
    const filtered = timestamps.filter(t => t > cutoff);
    if (filtered.length === 0) {
      requestLog.delete(ip);
    } else {
      requestLog.set(ip, filtered);
    }
  }

  // Limpiar blacklist expirada
  for (const [ip, entry] of blacklist) {
    if (entry.expiresAt && entry.expiresAt > 0 && now > entry.expiresAt) {
      blacklist.delete(ip);
    }
  }
}

// Iniciar limpieza periódica
setInterval(periodicCleanup, CLEANUP_INTERVAL_MS);

// ── Silent Block ──────────────────────────────────────────────────────────────
/**
 * Respuesta falsa silenciosa para IPs bloqueadas.
 * El atacante cree que su request fue exitoso.
 */
function silentBlock(res) {
  // Simular delay de procesamiento real (50-200ms)
  const delay = 50 + Math.random() * 150;
  setTimeout(() => {
    res.json({ ok: true });
  }, delay);
}

// ── Middleware Express ────────────────────────────────────────────────────────

/**
 * Middleware de rate limiting + blacklist.
 * Se aplica SOLO a rutas públicas (no al panel).
 */
function rateLimiterMiddleware(req, res, next) {
  const ip = getClientIP(req);
  req.clientIP = ip; // Guardar para uso en las rutas

  // CAPA 1: Verificación rápida contra blacklist en memoria
  if (isBlacklisted(ip)) {
    return silentBlock(res);
  }

  // CAPA 2: Contar requests y verificar límite
  const requestCount = checkRateLimit(ip);
  if (requestCount > MAX_REQUESTS) {
    // IP excedió el límite — bloquear
    addToBlacklist(ip, BLOCK_DURATION_MS);
    console.warn(`🚫 IP bloqueada por rate limiting: ${ip} (${requestCount} requests en ${WINDOW_SECONDS}s)`);
    return silentBlock(res);
  }

  next();
}

/**
 * Middleware ligero que solo extrae la IP sin aplicar rate limiting.
 * Para rutas del panel que no deben bloquearse.
 */
function extractIPMiddleware(req, res, next) {
  req.clientIP = getClientIP(req);
  next();
}

module.exports = {
  rateLimiterMiddleware,
  extractIPMiddleware,
  getClientIP,
  isBlacklisted,
  addToBlacklist,
  removeFromBlacklist,
  getBlacklistedIPs,
  silentBlock
};
