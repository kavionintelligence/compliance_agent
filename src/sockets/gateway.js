const jwt = require('jsonwebtoken');
const env = require('../config/env');
const {
  User,
  DeviceSession,
  SupportTicket,
  SupportMessage
} = require('../models');

const initializeSockets = (io) => {
  // Authentication Middleware for WebSocket Handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization;
      if (!token) {
        return next(new Error('Authentication failed. Connection token missing.'));
      }

      // Handle standard Bearer format if sent
      const cleanToken = token.startsWith('Bearer ') ? token.split(' ')[1] : token;
      const decoded = jwt.verify(cleanToken, env.JWT_SECRET);

      const user = await User.findById(decoded.userId);
      if (!user || user.status === 'suspended') {
        return next(new Error('User account is suspended or inactive.'));
      }

      // Save credentials into socket.data payload
      socket.data = {
        userId: user._id,
        organizationId: user.organizationId,
        deviceId: decoded.deviceId,
        role: user.role
      };

      next();
    } catch (err) {
      console.error('Socket handshake authentication failed:', err.message);
      next(new Error('Socket handshake authentication failed. Invalid token.'));
    }
  });

  io.on('connection', async (socket) => {
    const { userId, organizationId, deviceId, role } = socket.data;
    const logger = socket.server.opts.logger || console;

    // Join room scopes
    const orgRoom = `org:${organizationId}`;
    const userRoom = `user:${userId}`;
    const deviceRoom = `device:${deviceId}`;

    socket.join(orgRoom);
    socket.join(userRoom);
    socket.join(deviceRoom);

    if (role === 'admin' || role === 'support') {
      socket.join('room:admin');
    }

    // Save current socket ID to DeviceSession for push notifications mapping
    try {
      await DeviceSession.updateOne(
        { deviceId },
        { $set: { pushSocketId: socket.id, lastSeenAt: new Date() } }
      );
    } catch (error) {
      logger.error('Failed to link socket ID to DeviceSession:', error);
    }

    logger.info(`🔌 WebSocket Client connected [Device: ${deviceId}] [Socket: ${socket.id}]`);

    // ── Live Chat Handlers ───────────────────────────────────────────────────

    // Handle receiving client message
    socket.on('support:message', async (data, callback) => {
      try {
        let { ticketId, message } = data;
        if (!ticketId || !message) {
          if (callback) callback({ error: 'ticketId and message text are required.' });
          return;
        }

        // Map general ticket to org-specific ticket ID to avoid unique index violation
        if (ticketId === 'TICKET-GENERAL' && role !== 'admin') {
          ticketId = `TICKET-GENERAL-${organizationId}`;
        }

        let isNewTicket = false;
        // Validate ticket belongs to the user's organization
        let ticket = await SupportTicket.findOne({
          ticketId,
          organizationId: role === 'admin' ? { $exists: true } : organizationId
        });

        if (!ticket) {
          if (role !== 'admin' && ticketId === `TICKET-GENERAL-${organizationId}`) {
            ticket = await SupportTicket.create({
              ticketId: `TICKET-GENERAL-${organizationId}`,
              userId,
              organizationId,
              subject: 'App General Inquiry Support',
              status: 'open',
              priority: 'normal',
              lastMessageAt: new Date()
            });
            isNewTicket = true;
          } else {
            if (callback) callback({ error: 'Ticket not found or permission denied.' });
            return;
          }
        }

        // Create Message
        const chatMessage = await SupportMessage.create({
          ticketId,
          senderId: userId,
          senderRole: role === 'admin' ? 'admin' : 'user',
          message,
          createdAt: new Date()
        });

        // Update last message activity timestamp
        ticket.lastMessageAt = new Date();
        await ticket.save();

        const messagePayload = {
          ticketId,
          messageId: chatMessage._id,
          senderId: chatMessage.senderId,
          senderRole: chatMessage.senderRole,
          message: chatMessage.message,
          createdAt: chatMessage.createdAt
        };

        // Broadcast to org room (all other sessions of the client)
        socket.to(`org:${ticket.organizationId}`).emit('support:message', messagePayload);

        // Broadcast to admins
        socket.to('room:admin').emit('support:message', messagePayload);

        if (callback) callback({ status: 'sent', message: messagePayload });

        // Auto-reply for new tickets
        if (isNewTicket) {
          setTimeout(async () => {
            try {
              const autoReply = await SupportMessage.create({
                ticketId: ticket.ticketId,
                senderId: userId,
                senderRole: 'admin',
                message: 'will get back to you in few minutes',
                createdAt: new Date()
              });
              const autoPayload = {
                ticketId: autoReply.ticketId,
                messageId: autoReply._id,
                senderId: autoReply.senderId,
                senderRole: autoReply.senderRole,
                message: autoReply.message,
                createdAt: autoReply.createdAt
              };
              socket.emit('support:message', autoPayload);
              socket.to(`org:${ticket.organizationId}`).emit('support:message', autoPayload);
              socket.to('room:admin').emit('support:message', autoPayload);
            } catch (err) {
              logger.error('Failed to send auto-reply:', err);
            }
          }, 1000);
        }
      } catch (err) {
        logger.error('Error handling socket support:message:', err);
        if (callback) callback({ error: 'Failed to process support message.' });
      }
    });

    // Handle client typing notifications
    socket.on('support:typing', (data) => {
      const { ticketId, isTyping } = data;
      // Propagate typing alerts
      if (role === 'admin') {
        socket.to(orgRoom).emit('support:typing', { ticketId, isTyping, role: 'admin' });
      } else {
        socket.to('room:admin').emit('support:typing', { ticketId, isTyping, role: 'user', userId });
      }
    });

    // ── Disconnection ────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      logger.info(`🔌 WebSocket Client disconnected: ${socket.id}`);
      try {
        // Clear active socket mapping
        await DeviceSession.updateOne(
          { deviceId },
          { $unset: { pushSocketId: '' } }
        );
      } catch (error) {
        logger.error('Failed to unlink socket ID on disconnect:', error);
      }
    });
  });
};

module.exports = {
  initializeSockets
};
