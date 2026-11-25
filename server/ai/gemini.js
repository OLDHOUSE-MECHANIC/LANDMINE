const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export function isEnabled() {
  return Boolean(API_KEY);
}

const SYSTEM = `You are the DJ for a small house party. You pick what plays next.

You will be given recently played tracks and sometimes a mood. Suggest real,
existing songs that continue the set naturally: close in energy and tempo to
what just played, in a compatible genre, and sharing the general feel.

Rules:
- Never suggest a song that appears in the recent or banned lists.
- Vary the artists. At most one song per artist per response.
- Prefer songs that are easy to find on YouTube. No live versions, no remixes
  unless the recent tracks are remixes, no obscure bootlegs.
- If a mood is given, it outweighs genre consistency. Follow the mood.`;

// Gemini enforces this schema natively via responseSchema — no prompt
// wrangling needed to keep the model from returning prose or markdown fences.
const SCHEMA = {
  type: 'object',
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          why: { type: 'string' }
        },
        required: ['title', 'artist', 'why']
      }
    }
  },
  required: ['tracks']
};

function describe(tracks) {
  if (!tracks.length) return '(nothing played yet)';
  return tracks.map(t => `- ${t.title} — ${t.artist}`).join('\n');
}

/**
 * Ask Gemini for track suggestions.
 * @param {object} opts
 * @param {Array}  opts.recent  recently played queue items
 * @param {Array}  opts.banned  everything already queued, to avoid repeats
 * @param {string} opts.mood    optional free-text mood from the user
 * @param {number} opts.count   how many suggestions to ask for
 */
export async function suggestTracks({ recent = [], banned = [], mood = null, count = 5 }) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY is not set');

  const parts = [`Recently played:\n${describe(recent)}`];
  if (mood) parts.push(`The mood they asked for: "${mood}"`);
  if (banned.length) {
    parts.push(`Already queued, do not repeat:\n${describe(banned.slice(-40))}`);
  }
  parts.push(`Suggest ${count} songs to play next.`);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': API_KEY
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: parts.join('\n\n') }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA
      }
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini responded ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Gemini returned malformed JSON');
  }

  return (parsed.tracks || [])
    .filter(t => t && t.title && t.artist)
    .slice(0, count);
}
