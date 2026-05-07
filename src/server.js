require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const ffmpeg = require('fluent-ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'reelz_secret_key_change_in_production';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://fardeen:Mysha@reelz.giwipem.mongodb.net/reelz?appName=Reelz';
console.log('🔗 Connecting to MongoDB...');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const useCloudinary = !!(process.env.CLOUDINARY_CLOUD_NAME);
console.log(useCloudinary ? '☁️  Cloudinary enabled' : '💾 Using local storage (set CLOUDINARY env vars for permanent storage)');

// Middleware
app.use(cors());
app.use(express.json());

// Local upload dirs (fallback when Cloudinary not configured)
['uploads/videos', 'uploads/avatars', 'uploads/messages'].forEach(dir => {
  const fullPath = path.join(__dirname, '..', dir);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Multer storage — Cloudinary if configured, local disk otherwise
const makeStorage = (folder, resourceType = 'auto') => {
  if (useCloudinary) {
    return new CloudinaryStorage({
      cloudinary,
      params: { folder: `reelz/${folder}`, resource_type: resourceType }
    });
  }
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, `../uploads/${folder}`)),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).substr(2,6)}${path.extname(file.originalname)}`)
  });
};

// Helper: get public URL from uploaded file
const getFileUrl = (file) => {
  if (useCloudinary) return file.path; // Cloudinary returns full https URL in file.path
  return `/uploads/${file.fieldname === 'video' ? 'videos' : file.fieldname === 'avatar' ? 'avatars' : 'messages'}/${file.filename}`;
};

// Helper: extract video duration in ms via ffprobe (local files only)
const getVideoDuration = (filePath) =>
  new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(0);
      resolve(Math.round((metadata.format.duration || 0) * 1000));
    });
  });

const uploadVideo = multer({ storage: makeStorage('videos', 'video'), limits: { fileSize: 100 * 1024 * 1024 } });
const uploadAvatar = multer({ storage: makeStorage('avatars', 'image'), limits: { fileSize: 5 * 1024 * 1024 } });
const uploadMessageImage = multer({ storage: makeStorage('messages', 'image'), limits: { fileSize: 10 * 1024 * 1024 } });

// MongoDB connection
let db;
MongoClient.connect(MONGO_URI)
  .then(client => {
    db = client.db('reelz');
    console.log('✅ Connected to MongoDB');
    db.collection('users').createIndex({ username: 1 }, { unique: true });
    db.collection('users').createIndex({ email: 1 }, { unique: true });
    db.collection('messages').createIndex({ senderId: 1, receiverId: 1 });
    db.collection('follows').createIndex({ followerId: 1, followingId: 1 });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

// Block requests until DB ready
app.use((req, res, next) => {
  if (!db && req.path !== '/health') {
    return res.status(503).json({ error: 'Database not ready, please retry in a moment' });
  }
  next();
});

// Auth middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const sanitizeUser = (user) => {
  if (!user) return null;
  const { password, _id, ...rest } = user;
  return { ...rest, id: _id ? _id.toString() : rest.id };
};

const enrichVideo = async (video) => {
  const user = await db.collection('users').findOne({ _id: new ObjectId(video.userId) });
  return { ...video, id: video._id?.toString(), user: sanitizeUser(user) };
};

// ============= AUTH ROUTES =============
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, displayName } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    const existing = await db.collection('users').findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(400).json({ error: 'User already exists' });
    const user = {
      username, displayName: displayName || username, email,
      password: bcrypt.hashSync(password, 10),
      avatar: null, bio: '', followers: 0, following: 0, likes: 0,
      isPrivate: false, createdAt: new Date()
    };
    const result = await db.collection('users').insertOne(user);
    user._id = result.insertedId;
    const token = jwt.sign({ id: result.insertedId.toString(), username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ $or: [{ username }, { email: username }] });
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id.toString(), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= USER ROUTES =============
app.get('/api/users/me', authenticate, async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const videoCount = await db.collection('videos').countDocuments({ userId: user._id.toString() });
    res.json({ ...sanitizeUser(user), videoCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/me', authenticate, async (req, res) => {
  try {
    const { displayName, bio } = req.body;
    const update = {};
    if (displayName) update.displayName = displayName;
    if (bio !== undefined) update.bio = bio;
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: update });
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    res.json(sanitizeUser(user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/me/avatar', authenticate, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No avatar file' });
    const avatarUrl = useCloudinary ? req.file.path : `/uploads/avatars/${req.file.filename}`;
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { avatar: avatarUrl } });
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    res.json(sanitizeUser(user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/me/privacy', authenticate, async (req, res) => {
  try {
    const { isPrivate } = req.body;
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { isPrivate: !!isPrivate } });
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    res.json(sanitizeUser(user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/follow', authenticate, async (req, res) => {
  try {
    const targetId = req.params.id;
    const target = await db.collection('users').findOne({ _id: new ObjectId(targetId) });
    if (!target) return res.status(404).json({ error: 'User not found' });
    const existing = await db.collection('follows').findOne({ followerId: req.user.id, followingId: targetId });
    if (existing) {
      await db.collection('follows').deleteOne({ followerId: req.user.id, followingId: targetId });
      await db.collection('users').updateOne({ _id: new ObjectId(targetId) }, { $inc: { followers: -1 } });
      await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $inc: { following: -1 } });
      const updated = await db.collection('users').findOne({ _id: new ObjectId(targetId) });
      res.json({ following: false, followers: updated.followers });
    } else {
      await db.collection('follows').insertOne({ followerId: req.user.id, followingId: targetId, createdAt: new Date() });
      await db.collection('users').updateOne({ _id: new ObjectId(targetId) }, { $inc: { followers: 1 } });
      await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $inc: { following: 1 } });
      const updated = await db.collection('users').findOne({ _id: new ObjectId(targetId) });
      // Notify the person being followed
      const actor = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
      await createNotification(targetId, 'follow', req.user.id, sanitizeUser(actor), null, null);
      res.json({ following: true, followers: updated.followers });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET followers list
app.get('/api/users/:username/followers', async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const follows = await db.collection('follows').find({ followingId: user._id.toString() }).toArray();
    const users = await Promise.all(follows.map(f => db.collection('users').findOne({ _id: new ObjectId(f.followerId) })));
    res.json(users.filter(Boolean).map(sanitizeUser));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET following list
app.get('/api/users/:username/following', async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const follows = await db.collection('follows').find({ followerId: user._id.toString() }).toArray();
    const users = await Promise.all(follows.map(f => db.collection('users').findOne({ _id: new ObjectId(f.followingId) })));
    res.json(users.filter(Boolean).map(sanitizeUser));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Following feed
app.get('/api/feed/following', authenticate, async (req, res) => {
  try {
    const follows = await db.collection('follows').find({ followerId: req.user.id }).toArray();
    const ids = follows.map(f => f.followingId);
    if (!ids.length) return res.json({ videos: [], hasMore: false });
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const total = await db.collection('videos').countDocuments({ userId: { $in: ids } });
    const videos = await db.collection('videos').find({ userId: { $in: ids } }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).toArray();
    const enriched = await Promise.all(videos.map(enrichVideo));
    res.json({ videos: enriched, hasMore: page * limit < total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= NOTIFICATION ROUTES =============
async function createNotification(recipientId, type, actorId, actor, videoId, text) {
  if (recipientId === actorId) return;
  try {
    await db.collection('notifications').insertOne({ recipientId, type, actorId, actor, videoId: videoId || null, text: text || null, read: false, createdAt: new Date() });
  } catch (e) { /* non-fatal */ }
}

app.get('/api/notifications', authenticate, async (req, res) => {
  try {
    const notifications = await db.collection('notifications').find({ recipientId: req.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(notifications.map(n => ({ ...n, id: n._id.toString() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notifications/unread-count', authenticate, async (req, res) => {
  try {
    const count = await db.collection('notifications').countDocuments({ recipientId: req.user.id, read: false });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/read-all', authenticate, async (req, res) => {
  try {
    await db.collection('notifications').updateMany({ recipientId: req.user.id, read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const uploadAudio = multer({
  storage: makeStorage('audio', 'video'), // Cloudinary uses 'video' resource type for audio
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Upload audio/song before posting a video
app.post('/api/audio/upload', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });
    const audioUrl = useCloudinary ? req.file.path : `/uploads/audio/${req.file.filename}`;
    res.json({ url: audioUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/feed', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const total = await db.collection('videos').countDocuments();
    const videos = await db.collection('videos').find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    const enriched = await Promise.all(videos.map(enrichVideo));
    res.json({ videos: enriched, hasMore: page * limit < total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/videos/trending', async (req, res) => {
  try {
    const videos = await db.collection('videos').find().sort({ likes: -1 }).limit(20).toArray();
    const enriched = await Promise.all(videos.map(enrichVideo));
    res.json({ videos: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:username/videos', async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const videos = await db.collection('videos').find({ userId: user._id.toString() }).sort({ createdAt: -1 }).toArray();
    const enriched = await Promise.all(videos.map(enrichVideo));
    res.json({ videos: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/videos/upload', authenticate, uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file' });
    const { caption, hashtags, songTitle, songArtist, songUrl, songStartMs } = req.body;
    const videoUrl = useCloudinary ? req.file.path : `/uploads/videos/${req.file.filename}`;

    // Extract real video duration:
    //  - Cloudinary: duration (seconds) is returned on the multer file object after upload
    //  - Local disk:  run ffprobe against the saved file path
    let videoDurationMs = 0;
    if (useCloudinary) {
      videoDurationMs = Math.round((req.file.duration || 0) * 1000);
    } else {
      videoDurationMs = await getVideoDuration(req.file.path);
    }

    const video = {
      userId: req.user.id,
      filename: req.file.filename || req.file.public_id,
      url: videoUrl,
      caption: caption || '',
      hashtags: hashtags ? hashtags.split(',').map(h => h.trim()) : [],
      songTitle: songTitle || null,
      songArtist: songArtist || null,
      songUrl: songUrl || null,
      songStartMs: parseInt(songStartMs) || 0,
      videoDurationMs,
      likes: 0, comments: 0, shares: 0, views: 0,
      createdAt: new Date()
    };
    const result = await db.collection('videos').insertOne(video);
    video._id = result.insertedId;
    res.json(await enrichVideo(video));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/videos/:id/like', authenticate, async (req, res) => {
  try {
    const videoId = req.params.id;
    const video = await db.collection('videos').findOne({ _id: new ObjectId(videoId) });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const existing = await db.collection('likes').findOne({ userId: req.user.id, videoId });
    if (existing) {
      await db.collection('likes').deleteOne({ userId: req.user.id, videoId });
      await db.collection('videos').updateOne({ _id: new ObjectId(videoId) }, { $inc: { likes: -1 } });
      const updated = await db.collection('videos').findOne({ _id: new ObjectId(videoId) });
      res.json({ liked: false, likes: updated.likes });
    } else {
      await db.collection('likes').insertOne({ userId: req.user.id, videoId, createdAt: new Date() });
      await db.collection('videos').updateOne({ _id: new ObjectId(videoId) }, { $inc: { likes: 1 } });
      const updated = await db.collection('videos').findOne({ _id: new ObjectId(videoId) });
      const liker = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
      await createNotification(video.userId, 'like', req.user.id, sanitizeUser(liker), videoId, null);
      res.json({ liked: true, likes: updated.likes });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/videos/:id/view', async (req, res) => {
  try {
    await db.collection('videos').updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

app.delete('/api/videos/:id', authenticate, async (req, res) => {
  try {
    const video = await db.collection('videos').findOne({ _id: new ObjectId(req.params.id), userId: req.user.id });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    await db.collection('videos').deleteOne({ _id: new ObjectId(req.params.id) });
    try { fs.unlinkSync(path.join(__dirname, '../uploads/videos', video.filename)); } catch {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= COMMENT ROUTES =============
app.get('/api/videos/:id/comments', async (req, res) => {
  try {
    const comments = await db.collection('comments').find({ videoId: req.params.id }).sort({ createdAt: 1 }).toArray();
    const enriched = await Promise.all(comments.map(async c => {
      const user = await db.collection('users').findOne({ _id: new ObjectId(c.userId) });
      return { ...c, id: c._id.toString(), user: sanitizeUser(user) };
    }));
    res.json({ comments: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/videos/:id/comments', authenticate, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Comment text required' });
    const comment = { videoId: req.params.id, userId: req.user.id, text: text.trim(), likes: 0, createdAt: new Date() };
    const result = await db.collection('comments').insertOne(comment);
    await db.collection('videos').updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { comments: 1 } });
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    const video = await db.collection('videos').findOne({ _id: new ObjectId(req.params.id) });
    if (video) await createNotification(video.userId, 'comment', req.user.id, sanitizeUser(user), req.params.id, text.trim());
    res.json({ ...comment, id: result.insertedId.toString(), user: sanitizeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= SEARCH ROUTES =============
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json({ videos: [], users: [] });
    const regex = new RegExp(q, 'i');
    const users = await db.collection('users').find({ $or: [{ username: regex }, { displayName: regex }] }).limit(20).toArray();
    const videos = await db.collection('videos').find({ $or: [{ caption: regex }, { hashtags: regex }] }).limit(20).toArray();
    const enrichedVideos = await Promise.all(videos.map(enrichVideo));
    res.json({ users: users.map(sanitizeUser), videos: enrichedVideos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= MESSAGING ROUTES =============
app.get('/api/messages/conversations', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const messages = await db.collection('messages').find({ $or: [{ senderId: myId }, { receiverId: myId }] }).toArray();
    const latestByOther = new Map();
    messages.forEach(m => {
      const otherId = m.senderId === myId ? m.receiverId : m.senderId;
      const existing = latestByOther.get(otherId);
      if (!existing || new Date(m.timestamp) > new Date(existing.timestamp)) latestByOther.set(otherId, m);
    });
    const conversations = [];
    for (const [otherId, lastMessage] of latestByOther) {
      const otherUser = await db.collection('users').findOne({ _id: new ObjectId(otherId) });
      if (otherUser) conversations.push({ otherUser: sanitizeUser(otherUser), lastMessage, unreadCount: 0 });
    }
    conversations.sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));
    res.json(conversations);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/:userId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;
    const thread = await db.collection('messages').find({
      $or: [
        { senderId: myId, receiverId: otherId },
        { senderId: otherId, receiverId: myId }
      ]
    }).sort({ timestamp: 1 }).toArray();
    res.json(thread.map(m => ({ ...m, id: m._id.toString() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/:userId', authenticate, uploadMessageImage.single('image'), async (req, res) => {
  try {
    const receiverId = req.params.userId;
    const receiver = await db.collection('users').findOne({ _id: new ObjectId(receiverId) });
    if (!receiver) return res.status(404).json({ error: 'User not found' });
    const text = req.body.text || null;
    const imageUrl = req.file ? (useCloudinary ? req.file.path : `/uploads/messages/${req.file.filename}`) : null;
    if (!text && !imageUrl) return res.status(400).json({ error: 'Text or image required' });
    const sender = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    const message = { senderId: req.user.id, receiverId, text, imageUrl, timestamp: new Date(), sender: sanitizeUser(sender) };
    const result = await db.collection('messages').insertOne(message);
    res.json({ ...message, id: result.insertedId.toString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= ADMIN =============
app.get('/admin/users', async (req, res) => {
  try {
    const users = await db.collection('users').find().toArray();
    res.json(users.map(u => ({ id: u._id, username: u.username, email: u.email, displayName: u.displayName })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/reset', async (req, res) => {
  try {
    await db.collection('users').deleteMany({});
    await db.collection('videos').deleteMany({});
    await db.collection('messages').deleteMany({});
    await db.collection('follows').deleteMany({});
    await db.collection('likes').deleteMany({});
    await db.collection('comments').deleteMany({});
    res.json({ success: true, message: 'All data cleared' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Reelz Backend running on port ${PORT}`);
});

module.exports = app;
