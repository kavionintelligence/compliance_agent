const {
  User,
  Organization,
  ScanRun,
  LlmUsage,
  RemoteConfig,
  Notification,
  AppRelease,
  AdminAuditLog,
  SupportTicket,
  SupportMessage,
  Project,
  ScanRevision,
  TargetedRecheckJob,
  FindingChangeLog,
  EvidenceSubmission,
} = require('../models');

// Helper to write audit trail logs
const logAdminAction = async (req, action, targetType, targetId, before, after) => {
  try {
    await AdminAuditLog.create({
      adminId: req.user._id,
      action,
      targetType,
      targetId: String(targetId),
      before,
      after,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Writing audit log failed');
  }
};

// GET /api/v1/admin/users
const getUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-passwordHash -mfaSecret');
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/organizations
const getOrganizations = async (req, res) => {
  try {
    const orgs = await Organization.find({});
    res.status(200).json(orgs);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/scans/summary
const getScansSummary = async (req, res) => {
  try {
    const totalScans = await ScanRun.countDocuments({});
    const okScans = await ScanRun.countDocuments({ scanHealth: 'ok' });
    const warningScans = await ScanRun.countDocuments({ scanHealth: 'warning' });
    const failedScans = await ScanRun.countDocuments({ scanHealth: 'failed' });

    // Aggregated metrics
    const stats = await ScanRun.aggregate([
      {
        $group: {
          _id: null,
          avgDuration: { $avg: '$durationMs' },
          totalFindings: { $sum: '$findingCount' },
          totalProbes: { $sum: '$runtimeProbeCount' },
          totalPasses: { $sum: '$runtimePassCount' },
          totalGaps: { $sum: '$runtimeGapCount' },
          totalInconclusive: { $sum: '$runtimeInconclusiveCount' },
          totalBlocked: { $sum: '$runtimeBlockedCount' }
        }
      }
    ]);

    const aggregates = stats.length > 0 ? stats[0] : {
      avgDuration: 0,
      totalFindings: 0,
      totalProbes: 0,
      totalPasses: 0,
      totalGaps: 0,
      totalInconclusive: 0,
      totalBlocked: 0
    };

    res.status(200).json({
      total: totalScans,
      health: { ok: okScans, warning: warningScans, failed: failedScans },
      avgDurationMs: Math.round(aggregates.avgDuration || 0),
      totalFindingsFound: aggregates.totalFindings || 0,
      dvl: {
        totalProbes: aggregates.totalProbes || 0,
        totalPasses: aggregates.totalPasses || 0,
        totalGaps: aggregates.totalGaps || 0,
        totalInconclusive: aggregates.totalInconclusive || 0,
        totalBlocked: aggregates.totalBlocked || 0
      }
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Aggregating scans summary failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/usage/tokens
const getTokensUsage = async (req, res) => {
  try {
    const usageAggregate = await LlmUsage.aggregate([
      {
        $group: {
          _id: '$provider',
          totalPromptTokens: { $sum: '$promptTokens' },
          totalCompletionTokens: { $sum: '$completionTokens' },
          count: { $sum: 1 }
        }
      }
    ]);
    res.status(200).json(usageAggregate);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/admin/config
const updateRemoteConfig = async (req, res) => {
  try {
    const {
      environment,
      version,
      llm,
      features,
      api,
      minSupportedAppVersion,
      forceUpdateBelowVersion,
      releaseChannel
    } = req.body;

    if (!environment || !version) {
      return res.status(400).json({ error: 'environment and version are required fields.' });
    }

    const before = await RemoteConfig.findOne({ environment, active: true });

    // The portal never receives the stored API key back (it is redacted from
    // /config/client), so a blank key field means "keep the existing key".
    const llmConfig = llm ? { ...llm } : llm;
    if (llmConfig && !llmConfig.apiKey && before?.llm?.apiKey) {
      llmConfig.apiKey = before.llm.apiKey;
    }

    // Deactivate previous active configs for environment
    await RemoteConfig.updateMany({ environment }, { active: false });

    const newConfig = await RemoteConfig.create({
      environment,
      version,
      active: true,
      llm: llmConfig,
      features,
      api,
      minSupportedAppVersion,
      forceUpdateBelowVersion,
      releaseChannel,
      updatedBy: req.user._id
    });

    // Write audit trail
    await logAdminAction(req, 'UPDATE_REMOTE_CONFIG', 'config', newConfig._id, before, newConfig);

    // Broadcast Socket notification that configuration changed
    const io = req.app.get('io');
    io.emit('config:update_available', { environment, version });

    res.status(201).json({ status: 'ok', config: newConfig });
  } catch (error) {
    req.app.get('logger').error(error, 'Updating remote config failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/admin/notifications
const createNotification = async (req, res) => {
  try {
    const {
      title,
      message,
      severity,
      targetType,
      targetValue,
      expiresInSeconds
    } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'title and message are required fields.' });
    }

    const expiresAt = new Date(Date.now() + (expiresInSeconds || 86400) * 1000); // Default 1 day expiration

    const notification = await Notification.create({
      title,
      message,
      severity: severity || 'info',
      targetType: targetType || 'all',
      targetValue,
      createdBy: req.user._id,
      expiresAt
    });

    await logAdminAction(req, 'CREATE_NOTIFICATION', 'notification', notification._id, null, notification);

    // Dispatch broadcast via socket
    const io = req.app.get('io');
    io.emit('notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      severity: notification.severity,
      targetType: notification.targetType,
      targetValue: notification.targetValue
    });

    res.status(201).json({ status: 'ok', notification });
  } catch (error) {
    req.app.get('logger').error(error, 'Creating notification failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/admin/releases
const publishRelease = async (req, res) => {
  try {
    const {
      version,
      channel,
      platform,
      releaseNotes,
      downloadUrl,
      signature,
      sha512,
      mandatory,
      minVersion
    } = req.body;

    if (!version || !platform || !downloadUrl) {
      return res.status(400).json({ error: 'version, platform, and downloadUrl are required fields.' });
    }

    const release = await AppRelease.create({
      version,
      channel: channel || 'stable',
      platform,
      releaseNotes,
      downloadUrl,
      signature,
      sha512,
      mandatory: mandatory || false,
      minVersion,
      createdBy: req.user._id,
      publishedAt: new Date()
    });

    await logAdminAction(req, 'PUBLISH_RELEASE', 'release', release._id, null, release);

    res.status(201).json({ status: 'ok', release });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/audit-logs
const getAuditLogs = async (req, res) => {
  try {
    const logs = await AdminAuditLog.find({}).sort({ createdAt: -1 }).limit(100);
    res.status(200).json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/scans
const getScansList = async (req, res) => {
  try {
    const scans = await ScanRun.find({})
      .populate('userId', 'name email')
      .sort({ startedAt: -1 })
      .lean();

    // Group running scans count per user
    const runningScansCounts = await ScanRun.aggregate([
      { $match: { completedAt: { $exists: false } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } }
    ]);
    
    const countMap = {};
    runningScansCounts.forEach(g => { countMap[g._id.toString()] = g.count; });
    
    const enrichedScans = scans.map(s => ({
      ...s,
      userActiveScans: s.userId && s.userId._id ? (countMap[s.userId._id.toString()] || 0) : 0
    }));

    res.status(200).json(enrichedScans);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/support/tickets
const getSupportTickets = async (req, res) => {
  try {
    const tickets = await SupportTicket.find({})
      .populate('userId', 'name email')
      .sort({ lastMessageAt: -1 });
    res.status(200).json(tickets);
  } catch (error) {
    req.app.get('logger').error(error, 'Fetching support tickets failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/support/tickets/:ticketId/messages
const getTicketMessages = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const messages = await SupportMessage.find({ ticketId }).sort({ createdAt: 1 });
    res.status(200).json(messages);
  } catch (error) {
    req.app.get('logger').error(error, 'Fetching ticket messages failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/support/messages
const createUserSupportMessage = async (req, res) => {
  try {
    const { ticketId: rawTicketId, message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const ticketId = rawTicketId && rawTicketId !== 'TICKET-GENERAL'
      ? String(rawTicketId)
      : `TICKET-GENERAL-${req.org._id}`;

    let ticket = await SupportTicket.findOne({
      ticketId,
      organizationId: req.org._id,
    });

    let isNewTicket = false;
    if (!ticket) {
      ticket = await SupportTicket.create({
        ticketId,
        userId: req.user._id,
        organizationId: req.org._id,
        subject: 'App General Inquiry Support',
        status: 'open',
        priority: 'normal',
        lastMessageAt: new Date(),
      });
      isNewTicket = true;
    }

    const chatMessage = await SupportMessage.create({
      ticketId,
      senderId: req.user._id,
      senderRole: 'user',
      message: String(message).trim(),
      createdAt: new Date(),
    });

    ticket.lastMessageAt = new Date();
    if (ticket.status === 'closed') ticket.status = 'open';
    await ticket.save();

    const payload = {
      ticketId,
      messageId: chatMessage._id,
      senderId: chatMessage.senderId,
      senderRole: chatMessage.senderRole,
      message: chatMessage.message,
      createdAt: chatMessage.createdAt,
    };

    const io = req.app.get('io');
    if (io) {
      io.to('room:admin').emit('support:message', payload);
      io.to(`org:${req.org._id}`).emit('support:message', payload);
    }

    let autoReply = null;
    if (isNewTicket) {
      const adminReply = await SupportMessage.create({
        ticketId,
        senderId: req.user._id,
        senderRole: 'admin',
        message: 'will get back to you in few minutes',
        createdAt: new Date(),
      });
      autoReply = {
        ticketId,
        messageId: adminReply._id,
        senderId: adminReply.senderId,
        senderRole: adminReply.senderRole,
        message: adminReply.message,
        createdAt: adminReply.createdAt,
      };
      if (io) {
        io.to(`org:${req.org._id}`).emit('support:message', autoReply);
        io.to('room:admin').emit('support:message', autoReply);
      }
    }

    return res.status(201).json({ status: 'sent', ticketId, message: payload, autoReply });
  } catch (error) {
    req.app.get('logger').error(error, 'Creating user support message failed');
    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/support/messages
const getUserSupportMessages = async (req, res) => {
  try {
    const ticketId = req.query.ticketId && req.query.ticketId !== 'TICKET-GENERAL'
      ? String(req.query.ticketId)
      : `TICKET-GENERAL-${req.org._id}`;
    const ticket = await SupportTicket.findOne({ ticketId, organizationId: req.org._id });
    if (!ticket) return res.status(200).json({ ticketId, messages: [] });
    const messages = await SupportMessage.find({ ticketId }).sort({ createdAt: 1 });
    return res.status(200).json({ ticketId, messages });
  } catch (error) {
    req.app.get('logger').error(error, 'Fetching user support messages failed');
    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/admin/support/tickets/:ticketId/messages
const createAdminSupportMessage = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }
    const ticket = await SupportTicket.findOne({ ticketId });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    const chatMessage = await SupportMessage.create({
      ticketId,
      senderId: req.user._id,
      senderRole: req.user.role === 'support' ? 'support' : 'admin',
      message: String(message).trim(),
      createdAt: new Date(),
    });
    ticket.lastMessageAt = new Date();
    if (ticket.status === 'open') ticket.status = 'pending';
    await ticket.save();

    const payload = {
      ticketId,
      messageId: chatMessage._id,
      senderId: chatMessage.senderId,
      senderRole: chatMessage.senderRole,
      message: chatMessage.message,
      createdAt: chatMessage.createdAt,
    };

    const io = req.app.get('io');
    if (io) {
      io.to(`org:${ticket.organizationId}`).emit('support:message', payload);
      io.to('room:admin').emit('support:message', payload);
    }

    return res.status(201).json({ status: 'sent', ticketId, message: payload });
  } catch (error) {
    req.app.get('logger').error(error, 'Creating admin support message failed');
    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/projects
const getProjects = async (req, res) => {
  try {
    const projects = await Project.find({}).sort({ updatedAt: -1 }).lean();
    const enriched = await Promise.all(projects.map(async (project) => {
      const fullScans = await ScanRevision.countDocuments({ projectId: project._id, revisionType: 'full_scan' });
      const targetedFixes = await ScanRevision.countDocuments({ projectId: project._id, revisionType: 'targeted_fix' });
      const latestScan = await ScanRun.findOne({ projectId: project._id }).sort({ startedAt: -1 }).lean();
      return { ...project, fullScans, targetedFixes, latestScan };
    }));
    res.status(200).json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/projects/:projectId
const getProjectDetail = async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId).lean();
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const scans = await ScanRun.find({ projectId: project._id }).sort({ startedAt: -1 }).lean();
    const revisions = await ScanRevision.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(50).lean();
    const recheckJobs = await TargetedRecheckJob.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(50).lean();
    const findingChanges = await FindingChangeLog.find({ projectId: project._id }).sort({ changedAt: -1 }).limit(100).lean();

    res.status(200).json({ project, scans, revisions, recheckJobs, findingChanges });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/recheck-jobs
const getRecheckJobs = async (req, res) => {
  try {
    const jobs = await TargetedRecheckJob.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.status(200).json(jobs);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// GET /api/v1/admin/finding-changes
const getFindingChanges = async (req, res) => {
  try {
    const changes = await FindingChangeLog.find({}).sort({ changedAt: -1 }).limit(100).lean();
    res.status(200).json(changes);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  getUsers,
  getOrganizations,
  getScansSummary,
  getTokensUsage,
  updateRemoteConfig,
  createNotification,
  publishRelease,
  getAuditLogs,
  getScansList,
  getSupportTickets,
  getTicketMessages,
  createUserSupportMessage,
  getUserSupportMessages,
  createAdminSupportMessage,
  getProjects,
  getProjectDetail,
  getRecheckJobs,
  getFindingChanges,
};
