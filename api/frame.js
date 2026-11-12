// GET /api/frame?id=&n= — one saved screen of a test, as a JPEG.
import { route, query, HttpError } from './_lib/util.js';
import { store } from './_lib/store.js';

export default route(['GET'], async (req, res) => {
  const q = query(req); const db = store();
  if (!db) throw new HttpError(503, 'not configured');
  const jpg = await db.frame(Number(q.id), Number(q.n));
  if (!jpg) throw new HttpError(404, 'no such frame');
  res.statusCode = 200; res.setHeader('content-type', 'image/jpeg'); res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.end(Buffer.from(jpg, 'base64'));
});
