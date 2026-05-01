-- TinAI Cloud - PostgreSQL Initialisation
-- Runs once when the postgres container is first created

-- Create databases for each service
CREATE DATABASE tinai_forge;
CREATE DATABASE forgejo;

-- Grant access to tinai user
GRANT ALL PRIVILEGES ON DATABASE tinai TO tinai;
GRANT ALL PRIVILEGES ON DATABASE tinai_forge TO tinai;
GRANT ALL PRIVILEGES ON DATABASE forgejo TO tinai;

-- Main tinai schema
\c tinai
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- tinai_forge schema
\c tinai_forge
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
