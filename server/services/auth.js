const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./db');
const router  = express.Router();

function getUserStatus(user) {
  if (user.is_admin) return 'active';
  if (!user.is_approved) return 'pending';
  if (!user.subscription_expires_at) return 'expired';
  return new Date(user.subscription_expires_at) > new Date() ? 'active' : 'expired';
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email,
    is_admin: u.is_admin, is_approved: u.is_approved,
    subscription_expires_at: u.subscription_expires_at,
    status: getUserStatus(u),
  };
}

router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe: 6 caractères minimum' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await db.createUser({ username: username.trim(), email: email.trim().toLowerCase(), password_hash: hash });
    res.json({ message: "Inscription réussie. En attente de validation par l'administrateur.", user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505' || err.message === 'username taken' || err.message === 'email taken') {
      const field = (err.field === 'email' || (err.detail && err.detail.includes('email'))) ? 'email' : "nom d'utilisateur";
      return res.status(409).json({ error: `Ce ${field} est déjà utilisé` });
    }
    console.error('register error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Identifiants requis' });
  try {
    const user = await db.getUserByLogin(username.trim());
    if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });
    req.session.userId  = user.id;
    req.session.isAdmin = user.is_admin;
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Déconnecté' }));
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const user = await db.getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Session invalide' });
    res.json(publicUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
