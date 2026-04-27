// FF1 Karting — Scheduled Notification Function
// Runs daily at 9am Melbourne time via Netlify Cron
// Checks race dates and sends FCM push notifications automatically

const FIREBASE_PROJECT = 'fatfurious1-343e2';
const SA_EMAIL = 'firebase-adminsdk-fbsvc@fatfurious1-343e2.iam.gserviceaccount.com';

// Venue names lookup
const VENUE_NAMES = {
  1:'Albion', 2:'Dandenong South', 3:'Campbellfield', 4:'Thomastown',
  5:'Moorabbin', 6:'Bayswater', 7:'West Footscray', 8:'Braybrook',
  9:'Port Melbourne', 10:'Dandenong South', 11:'Braybrook', 12:'Phillip Island'
};

// Race schedule — dates in Melbourne time
const RACE_DATES = [
  { round:1,  date:'2026-03-15', name:'Albion' },
  { round:2,  date:'2026-04-12', name:'Dandenong South' },
  { round:3,  date:'2026-05-10', name:'Campbellfield' },
  { round:4,  date:'2026-05-31', name:'Thomastown' },
  { round:5,  date:'2026-06-28', name:'Moorabbin' },
  { round:6,  date:'2026-07-26', name:'Bayswater' },
  { round:7,  date:'2026-08-23', name:'West Footscray' },
  { round:8,  date:'2026-09-15', name:'Braybrook' },
  { round:9,  date:'2026-10-18', name:'Port Melbourne' },
  { round:10, date:'2026-11-01', name:'Dandenong South' },
  { round:11, date:'2026-11-22', name:'Braybrook' },
  { round:12, date:'2026-12-06', name:'Phillip Island' },
];

// ── JWT / OAuth2 helpers ──
async function base64url(data) {
  const b64 = Buffer.from(data).toString('base64');
  return b64.replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function getAccessToken() {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);

  const header = await base64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const payload = await base64url(JSON.stringify({
    iss: SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));

  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt = header + '.' + payload + '.' + sig;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Firebase REST helpers ──
async function firestoreGet(token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  return res.json();
}

async function firestoreSet(token, path, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const body = { fields };
  const res = await fetch(url + '?updateMask.fieldPaths=' + Object.keys(fields).join('&updateMask.fieldPaths='), {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function fsString(v) { return { stringValue: String(v) }; }
function fsInt(v)    { return { integerValue: String(v) }; }
function fsBool(v)   { return { booleanValue: v }; }

// ── Send FCM to all tokens ──
async function sendToAll(token, title, body, url = '/') {
  // Get all FCM tokens from Firestore
  const tokensDoc = await firestoreGet(token, 'fcm_tokens');
  const documents = tokensDoc.documents || [];
  
  let sent = 0, failed = 0;
  for (const doc of documents) {
    const fcmToken = doc.fields?.token?.stringValue;
    if (!fcmToken) continue;
    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT}/messages:send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification: { title, body },
            webpush: {
              notification: {
                title, body,
                icon: 'icon-192.png',
                badge: 'icon-32.png',
                vibrate: [200, 100, 200]
              },
              fcm_options: { link: url }
            },
            data: { url, title, body }
          }
        })
      });
      if (res.ok) sent++; else failed++;
    } catch(e) { failed++; }
  }
  return { sent, failed };
}

// ── Check if notification already sent today ──
async function alreadySent(token, notifKey) {
  try {
    const doc = await firestoreGet(token, `notification_log/${notifKey}`);
    return !!doc.fields?.sent?.booleanValue;
  } catch(e) { return false; }
}

async function markSent(token, notifKey, title) {
  await firestoreSet(token, `notification_log/${notifKey}`, {
    sent: fsBool(true),
    title: fsString(title),
    sentAt: fsString(new Date().toISOString())
  });
}

// ── Main scheduler logic ──
exports.handler = async function(event, context) {
  console.log('FF1 Scheduler running:', new Date().toISOString());
  
  try {
    const token = await getAccessToken();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const notifications = [];

    for (const race of RACE_DATES) {
      const raceDate = new Date(race.date);
      raceDate.setHours(0, 0, 0, 0);
      const daysUntil = Math.round((raceDate - today) / (1000 * 60 * 60 * 24));

      // 14 days before — register reminder
      if (daysUntil === 14) {
        notifications.push({
          key: `r${race.round}-14day`,
          title: `⚑ FF1 — R${race.round} in 2 weeks`,
          body: `${race.name} is 2 weeks away. Have you registered yet?`,
          url: `/attend.html?round=${race.round}`
        });
      }

      // 7 days before — reminder
      if (daysUntil === 7) {
        notifications.push({
          key: `r${race.round}-7day`,
          title: `⚑ FF1 — R${race.round} in 1 week`,
          body: `One week until ${race.name}! Register now if you haven't.`,
          url: `/attend.html?round=${race.round}`
        });
      }

      // 2 days before — race soon
      if (daysUntil === 2) {
        notifications.push({
          key: `r${race.round}-2day`,
          title: `🏎️ FF1 — R${race.round} this weekend`,
          body: `${race.name} is in 2 days. See you on track!`,
          url: `/#schedule`
        });
      }

      // Race day
      if (daysUntil === 0) {
        notifications.push({
          key: `r${race.round}-raceday`,
          title: `🏁 FF1 — Race Day!`,
          body: `It's race day! R${race.round} ${race.name} today. Good luck everyone!`,
          url: `/#schedule`
        });
      }

      // Day after race — results reminder
      if (daysUntil === -1) {
        notifications.push({
          key: `r${race.round}-results`,
          title: `📊 FF1 — R${race.round} Results`,
          body: `R${race.round} ${race.name} is done. Check the results and updated standings!`,
          url: `/#results`
        });
      }
    }

    // Send each notification (skip if already sent)
    const results = [];
    for (const notif of notifications) {
      const sent = await alreadySent(token, notif.key);
      if (sent) {
        console.log(`Already sent: ${notif.key}`);
        continue;
      }
      const result = await sendToAll(token, notif.title, notif.body, notif.url);
      await markSent(token, notif.key, notif.title);
      results.push({ ...notif, ...result });
      console.log(`Sent ${notif.key}: ${result.sent} devices`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        date: today.toISOString(),
        notificationsSent: results.length,
        results
      })
    };

  } catch(e) {
    console.error('Scheduler error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
