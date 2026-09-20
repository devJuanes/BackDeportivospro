# DeportivosPro API — MatuDB

Este backend usa `@devjuanes/matuclient`. Documentación del cliente abajo.

## Variables en `.env` (backend)

```env
MATUDB_URL=https://db.matudb.com
MATUDB_PROJECT_ID=tu-project-uuid
MATUDB_API_KEY=anon_xxxxxxxx          # ANON KEY del panel (no mb_…)
MATUDB_USE_SUPABASE=false
```

La key del panel debe empezar con **`anon_`**. Las `mb_…` dan `Invalid or expired API key`.

Al arrancar (`npm run dev` / `npm start`) el servidor aplica el schema automáticamente (`DB_AUTO_MIGRATE=true`) y, si hoy no hay picks, ejecuta la fábrica LATAM (`BOOTSTRAP_FACTORY_ON_START=true`).

## Auto-publish a planta (MatuPicks Flutter)

Con `FACTORY_AUTO_PUBLISH=true` (default), cada tip generado se inserta de inmediato en:

| Tier | Tabla MatuDB |
|------|----------------|
| Free | `abet` (`FACTORY_PROD_FREE_TABLE`) |
| VIP  | `abetvip` (`FACTORY_PROD_VIP_TABLE`) |
| Live | `abetlive` (monitor en vivo) |

Cola interna: `dp_predictions` (también `published=true` al crear). No hay workflow de aprobación humana.

Timezone de `match_date` / `match_hour`: `FACTORY_TIMEZONE` (default `America/Bogota`).

### Live lifecycle

- Solo tips del **día actual** (Bogotá) con `state=live` aparecen en el feed.
- Cron `live_monitor` (`CRON_LIVE_EXPRESSION`, default cada 5 min): publica señales, refresca marcador, liquida al finalizar y limpia filas stale.
- Al insertar en `abetlive` se encola `dp_tracking_jobs` (`abetlive_id`); cron `prediction_tracking` (cada 2 min) refuerza el settle.
- Al terminar: `state=ended`, `live_ended=true`, `outcome` ∈ {won,lost,pending}.

```bash
npm run dev
```

Migración manual (opcional):

```bash
npm run db:migrate
```

Verificar:

```bash
# Estado fábrica + flags auto_publish / ai_agent_mode
curl -s http://127.0.0.1:3009/api/factory/status | jq .auto_publish,.ai_agent_mode,.timezone

# Forzar ciclo (admin)
curl -s -X POST http://127.0.0.1:3009/api/factory/run-now -H "Authorization: Bearer <admin>"
```

---

@devjuanes/matuclient
2.2.3 • Public • Published 4 months ago
@devjuanes/matuclient
npm version MIT License TypeScript Node.js

Official JavaScript/TypeScript client for MatuDB — A self-hosted database platform with real-time, authentication, and storage. Developed by DevJuanes (Juan Esteban Landazuri) from Cali, Colombia.

About MatuDB
MatuDB is a self-hosted database platform created by Juan Esteban Landazuri (DevJuanes), a senior full-stack developer from Cali, Colombia with 15+ years of experience. It provides:

Full data ownership — Your database stays on your servers
PostgreSQL power — Full relational database capabilities
Real-time updates — WebSocket-based live subscriptions
Authentication — JWT-based auth system
File storage — Upload, download, and manage files
Built by DevJuanes
Website: https://devjuanes.com
GitHub: https://github.com/DevJuanes
NPM: @devjuanes/matuclient
Installation
npm install @devjuanes/matuclient
Or use locally (within the MatuDB monorepo):

npm install ../matu-db-api/packages/matuclient
Features
PostgreSQL Database — Full relational database power
Real-time Subscriptions — WebSocket-based live updates via Socket.io
Authentication — JWT-based auth system
File Storage — Upload, download, and manage files
TypeScript Support — Full type definitions included
Supabase-compatible API — Familiar patterns for developers
Quick Start
import { createClient } from '@devjuanes/matuclient';

const db = createClient({
  url: 'http://localhost:3001',
  projectId: 'my-project',
  apiKey: 'anon_xxxx',
});

// Query data
const { data, error } = await db.from('users').select('*').eq('active', true);
Configuration
Automatic Configuration (Environment Variables)
MATUDB_URL=http://localhost:3001
MATUDB_PROJECT_ID=my-project
MATUDB_API_KEY=anon_xxxx...
MATUDB_USE_SUPABASE=false
Manual Configuration
import { createClient } from '@devjuanes/matuclient';

const db = createClient({
  url: 'http://localhost:3001',
  projectId: 'my-project',
  apiKey: 'anon_xxxx',
  useSupabase: false
});
API Reference
db.from(table) — Query Builder
// SELECT with filters
const { data, error } = await db
  .from('users')
  .select('id, name, email')
  .eq('active', true)
  .order('created_at', { ascending: false })
  .limit(10);

// Filter operators
.eq('col', value)       // =
.neq('col', value)      // !=
.gt('col', value)       // >
.gte('col', value)      // >=
.lt('col', value)       // <
.lte('col', value)      // <=
.like('col', '%patt%')  // LIKE
.ilike('col', '%patt%') // ILIKE (case-insensitive)
.in('col', [1, 2, 3])   // IN (...)
.is('col', null)        // IS NULL / IS TRUE / IS FALSE

// Single row
const { data: user } = await db.from('users').select('*').eq('id', userId).single();

// INSERT
const { data, error } = await db.from('products').insert({ name: 'Widget', price: 9.99 });

// INSERT multiple
const { data } = await db.from('products').insert([{ name: 'A' }, { name: 'B' }]);

// UPDATE
const { data } = await db.from('users').update({ name: 'Alice' }).eq('id', userId);

// DELETE
const { data } = await db.from('orders').delete().eq('id', orderId);
db.auth — Authentication
// Sign up
const { data, error } = await db.auth.signUp({ email, password });

// Sign in
const { data, error } = await db.auth.signInWithPassword({ email, password });
// data = { user, session: { access_token, expires_at, user } }

// Sign out
await db.auth.signOut();

// Get current session
const { data: { session } } = await db.auth.getSession();

// Get current user
const { data: { user } } = await db.auth.getUser();

// Listen for auth changes
const { data: { subscription } } = db.auth.onAuthStateChange((event, session) => {
  console.log(event); // 'SIGNED_IN' | 'SIGNED_OUT'
});
// Cleanup:
subscription.unsubscribe();
db.storage — File Storage
// Upload
const { data, error } = await db.storage.upload('avatar.png', file);

// Get public URL
const { data: { publicUrl } } = db.storage.getPublicUrl('avatar.png');

// List files
const { data: files } = await db.storage.list();

// Download
const { data: blob } = await db.storage.download('report.pdf');

// Delete
await db.storage.remove(['old-file.png', 'another.pdf']);
db.channel() — Realtime
// Supabase-compatible style
const channel = db
  .channel('public:users')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, payload => {
    console.log('Change:', payload);
  })
  .subscribe();

// Short style
db.channel('orders')
  .on('INSERT', payload => console.log('New order:', payload.data))
  .on('DELETE', payload => console.log('Deleted:', payload.data))
  .subscribe();

// Cleanup
db.removeChannel(channel);
db.removeAllChannels();
db.rpc() — Raw SQL
const { data, error } = await db.rpc('SELECT * FROM users WHERE created_at > NOW() - INTERVAL \'7 days\'');
Related Packages
matu-db-api — The MatuDB backend server
matudeploy — Deployment tools
License
MIT License — Developed with ❤️ in Cali, Colombia by DevJuanes