// Cloud-runnable publisher: no Puppeteer/ffmpeg, no local filesystem outside this repo checkout.
// All media is pre-staged in mes2/dia-<day>/. Reads the Instagram token from IG_TOKEN env var.
// Usage: IG_TOKEN=xxx node publish-cloud.js            -> publishes whatever is due today
//        IG_TOKEN=xxx node publish-cloud.js --day 13   -> force a specific day

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO_ROOT = __dirname;
const CALENDAR_PATH = path.join(REPO_ROOT, 'calendario-mes2.json');
const GH_USER = 'zubic06-oss';
const GH_REPO = 'jsnexona-media-hosting';
const IG_USER_ID = '17841446418857528';
const API = 'https://graph.facebook.com/v20.0';

function log(...a) { console.log(new Date().toISOString(), ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 300))); } });
    }).on('error', reject);
  });
}

function httpPostJson(url, formFields) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formFields).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 300))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function rawUrl(day, filename) {
  return `https://raw.githubusercontent.com/${GH_USER}/${GH_REPO}/main/mes2/dia-${day}/${filename}`;
}

async function publishCarousel(day, token) {
  const dir = path.join(REPO_ROOT, 'mes2', `dia-${day}`);
  const caption = fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8');
  const slides = fs.readdirSync(dir).filter(f => f.startsWith('slide-') && f.endsWith('.png')).sort();
  log(`Publishing carousel day ${day}: ${slides.length} slides`);

  const childIds = [];
  for (const s of slides) {
    const r = await httpPostJson(`${API}/${IG_USER_ID}/media`, { image_url: rawUrl(day, s), is_carousel_item: 'true', access_token: token });
    if (!r.id) throw new Error('Failed to create carousel child: ' + JSON.stringify(r));
    childIds.push(r.id);
  }
  const parent = await httpPostJson(`${API}/${IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: childIds.join(','), caption, access_token: token });
  if (!parent.id) throw new Error('Failed to create carousel parent: ' + JSON.stringify(parent));
  return httpPostJson(`${API}/${IG_USER_ID}/media_publish`, { creation_id: parent.id, access_token: token });
}

async function publishReel(day, token) {
  const dir = path.join(REPO_ROOT, 'mes2', `dia-${day}`);
  const caption = fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8');
  const videoUrl = rawUrl(day, 'video.mp4');
  log(`Publishing reel day ${day}: ${videoUrl}`);

  const container = await httpPostJson(`${API}/${IG_USER_ID}/media`, { media_type: 'REELS', video_url: videoUrl, caption, access_token: token });
  if (!container.id) throw new Error('Failed to create reel container: ' + JSON.stringify(container));

  let status = 'IN_PROGRESS';
  for (let i = 0; i < 30 && status !== 'FINISHED'; i++) {
    await sleep(10000);
    const s = await httpGetJson(`${API}/${container.id}?fields=status_code&access_token=${token}`);
    status = s.status_code;
    log('  processing status:', status);
    if (status === 'ERROR') throw new Error('Video processing failed: ' + JSON.stringify(s));
  }
  if (status !== 'FINISHED') throw new Error('Video still processing after 5 min, aborting publish.');

  return httpPostJson(`${API}/${IG_USER_ID}/media_publish`, { creation_id: container.id, access_token: token });
}

async function main() {
  const token = process.env.IG_TOKEN;
  if (!token) throw new Error('IG_TOKEN env var not set.');

  // Always pull latest calendar first in case another runner (local or cloud) already handled something.
  try { execFileSync('git', ['pull', '--rebase'], { cwd: REPO_ROOT }); } catch (e) { log('git pull warning:', e.message); }

  const calendar = JSON.parse(fs.readFileSync(CALENDAR_PATH, 'utf8'));
  const forceDay = process.argv.includes('--day') ? parseInt(process.argv[process.argv.indexOf('--day') + 1], 10) : null;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const nowHM = now.toTimeString().slice(0, 5);

  const due = calendar.filter(item => {
    if (item.status !== 'pending') return false;
    if (forceDay) return item.day === forceDay;
    return item.date === todayStr && item.time <= nowHM;
  });

  if (!due.length) { log('Nothing due to publish right now.'); return; }

  for (const item of due) {
    if (item.blocker) { log(`SKIPPING day ${item.day}: blocked — ${item.blocker}`); continue; }
    try {
      const result = item.type === 'carousel' ? await publishCarousel(item.day, token) : await publishReel(item.day, token);
      log(`✅ Published day ${item.day} ->`, result);
      item.status = 'published';
      item.publishedAt = new Date().toISOString();
      item.instagramMediaId = result.id;
    } catch (e) {
      log(`❌ FAILED day ${item.day}:`, e.message);
      item.status = 'failed';
      item.error = e.message;
    }
    fs.writeFileSync(CALENDAR_PATH, JSON.stringify(calendar, null, 2));
    try {
      execFileSync('git', ['add', 'calendario-mes2.json'], { cwd: REPO_ROOT });
      execFileSync('git', ['commit', '-m', `update calendar after day ${item.day}`], { cwd: REPO_ROOT });
      execFileSync('git', ['push'], { cwd: REPO_ROOT });
    } catch (e) { log('git commit/push warning:', e.message); }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
