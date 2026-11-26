-- The global ledger for Grand Towing and Delivery: South Pas (D1, bound to the Pages project as LEDGER).
-- Apply once:  wrangler d1 execute gtad-ledger --remote --file ledger/schema.sql
-- Money is whole town dollars (the game's amounts after EconomyMoney.MoneyScale), never negative.

CREATE TABLE IF NOT EXISTS accounts (
  id        TEXT PRIMARY KEY,                    -- "a_" + 24 hex, made by the server
  secret    TEXT NOT NULL,                       -- 64 hex; the key for this account's request signatures (HMAC-SHA256)
  name      TEXT NOT NULL,
  cash      INTEGER NOT NULL DEFAULT 0 CHECK (cash >= 0),
  imported  INTEGER NOT NULL DEFAULT 0,          -- 1 once its local save was brought in (only ever once)
  created   INTEGER NOT NULL,
  seen      INTEGER NOT NULL
);

-- Who owns each place (business, landmark, house) or kerb car: one owner at a time, by the primary key.
CREATE TABLE IF NOT EXISTS owners (
  thing     TEXT PRIMARY KEY,                    -- catalogue id ("b113" City Hall, "h261") or a kerb car id ("Civic@512,-388")
  account   TEXT NOT NULL REFERENCES accounts(id),
  level     INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  paid      INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),
  since     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owners_by_account ON owners(account);

-- Vehicles, parts, paints and outfits an account has: each once.
CREATE TABLE IF NOT EXISTS unlocks (
  account   TEXT NOT NULL REFERENCES accounts(id),
  unlock    TEXT NOT NULL,
  since     INTEGER NOT NULL,
  PRIMARY KEY (account, unlock)
);

-- Commit batches from hosts, by the host's own id: a batch is applied once, and a repeat gets the first answer back.
CREATE TABLE IF NOT EXISTS batches (
  id        TEXT PRIMARY KEY,
  host      TEXT NOT NULL REFERENCES accounts(id),
  at        INTEGER NOT NULL,
  first_seq INTEGER,
  entries   INTEGER NOT NULL
);

-- The ledger: append only. Every change to cash, ownership or unlocks writes one line here in the same transaction.
CREATE TABLE IF NOT EXISTS entries (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  batch     TEXT,                                -- the commit batch, or NULL (account made, save brought in)
  host      TEXT,
  kind      TEXT NOT NULL,                       -- join, import, pay, spend, give, buy, sell, upgrade, unlock, transfer
  account   TEXT NOT NULL,
  other     TEXT,                                -- the other side of a give or transfer
  thing     TEXT,
  amount    INTEGER NOT NULL DEFAULT 0,          -- + to the account, - from it
  why       TEXT
);
CREATE INDEX IF NOT EXISTS entries_by_account ON entries(account, seq);
CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'the ledger is append only'); END;
CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'the ledger is append only'); END;

-- A guard row: a batch inserts NULL here when one of its conditions does not hold, which fails the whole batch.
CREATE TABLE IF NOT EXISTS guard (ok INTEGER NOT NULL, why TEXT);
