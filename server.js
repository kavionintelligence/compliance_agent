const express = require('express');
const path = require('path');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const pino = require('pino');

const mongoose = require('mongoose');
const env = require('./src/config/env');
const { connectDatabase, connection } = require('./src/config/mongo');

// Initialize Pino Logger
const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true },
  } : undefined,
});

const isServerless = Boolean(process.env.VERCEL);

const app = express();
const server = isServerless ? null : http.createServer(app);

// Socket.io requires a persistent HTTP server (not available on Vercel serverless)
const io = isServerless
  ? null
  : new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

app.set('io', io);
app.set('logger', logger);

// Basic Security Middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "http:"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "ws:", "wss:", "http://localhost:3000", "https:", "http:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));
app.use(cors({
  origin: '*', // Adjust to specific client URL in staging/production
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Body parser with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// NoSQL Injection Protection
app.use(mongoSanitize());

// Rate Limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Ensure MongoDB is connected before handling API requests (serverless-safe)
app.use(async (req, res, next) => {
  if (connection.readyState === 1) return next();
  try {
    await connectDatabase();
    return next();
  } catch (err) {
    logger.error(err, 'Database connection failed');
    return res.status(503).json({ error: 'Database unavailable. Please try again shortly.' });
  }
});

// Auth-specific rate limiter (more strict)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 register/login requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
});
app.set('authLimiter', authLimiter);

// ── Health Check Endpoints ───────────────────────────────────────────────────

// Liveness check (checks if process is alive)
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// Readiness check (checks if DB and other services are ready)
app.get('/readyz', (req, res) => {
  const dbStatus = connection.readyState;
  // 1 = connected, 2 = connecting
  if (dbStatus === 1) {
    return res.status(200).json({ status: 'ready', database: 'connected' });
  }
  return res.status(503).json({ status: 'not_ready', database: 'disconnected' });
});

// Mount API Routes Router
const apiRouter = require('./src/routes/api');
app.use('/api/v1', apiRouter);

// Mount Admin Portal Static Console
const adminPortalDir = path.join(__dirname, 'admin-portal');
app.get('/admin', (req, res) => {
  res.sendFile(path.join(adminPortalDir, 'index.html'));
});
app.use('/admin', express.static(adminPortalDir));

// Fallback Route
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err, 'Unhandled Application Error');
  res.status(500).json({ error: 'Internal server error occurred.' });
});

// Bootstrap Database & Server
const startServer = async () => {
  await connectDatabase();

  server.listen(env.PORT, () => {
    logger.info(`🚀 ByoSync Connected Server running in [${env.NODE_ENV}] mode on port ${env.PORT}`);
  });
};

if (!isServerless) {
  const { initializeSockets } = require('./src/sockets/gateway');
  initializeSockets(io);

  const gracefulShutdown = () => {
    logger.info('⚠️ Shutting down server gracefully...');
    server.close(async () => {
      logger.info('HTTP server closed.');
      await mongoose.connection.close(false);
      logger.info('Mongo connection closed. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

if (require.main === module) {
  startServer();
}

// Vercel serverless expects the Express app as the default export
module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.io = io;
