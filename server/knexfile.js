import 'dotenv/config';

const connection = process.env.DATABASE_URL || {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'dudeai',
  password: process.env.PGPASSWORD || 'dudeai',
  database: process.env.PGDATABASE || 'dudeai',
};

const base = {
  client: 'pg',
  connection,
  pool: { min: 0, max: Number(process.env.PG_POOL_MAX || 10) },
  migrations: { directory: './migrations', extension: 'js', loadExtensions: ['.js'] },
  seeds: { directory: './seeds', loadExtensions: ['.js'] },
};

export default {
  development: base,
  production: { ...base, pool: { min: 2, max: Number(process.env.PG_POOL_MAX || 20) } },
};
