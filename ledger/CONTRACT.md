# South Pas ledger: API contract (v1)

One global town for Grand Towing and Delivery: South Pas. Cash, who owns which place or kerb car, unlocks and trades live in one
ledger at `https://lewispolansky.com/ledger/v1/`. Each game keeps its local save as the offline fallback.

Code: `functions/ledger/[[path]].js`. Schema: `ledger/schema.sql`. Tests: `node --test ledger/test` (offline) and
`ledger/test/live.mjs` (against a running copy).

## Units and ids

- Money is whole town dollars, the game's amounts after `EconomyMoney.MoneyScale`. It is never negative.
- Account ids look like `a_` followed by 24 hex characters. The server makes them.
- Places use catalogue ids (`b113` is City Hall, `h261` is 1120 Meridian Ave). Kerb cars use their kerb id (`Civic@512,-388`).
  Unlocks use unlock ids (`car_van`, `paint_teal`). Any id may use 1 to 64 of the characters `A-Z a-z 0-9 _ @ . , : + -`.
- `seq` is the ledger's line number. It only grows.

## Signing

Each account has a secret: 64 hex characters, handed out once when the account is made. The game stores it in its local save,
next to the account id. Never log or show it. Every request except `accounts` and `health` carries three headers:

| Header | Value |
|---|---|
| `X-Ledger-Account` | the account id |
| `X-Ledger-Time` | Unix time in milliseconds, within 5 minutes of the server's clock |
| `X-Ledger-Sig` | lowercase hex of HMAC-SHA256(secret, `METHOD + "\n" + path_and_query + "\n" + time + "\n" + hex(SHA-256(body)))`) |

`path_and_query` is exactly what is sent, for example `/ledger/v1/feed?after=10&limit=100`. The body is the exact UTF-8 bytes
sent, or the empty string for a GET. A request that fails the check is answered `401 {"ok":false,"error":"unsigned"}`.

## Endpoints

Every answer is JSON with `ok`. Failures add `error` and usually `why`.

### `POST /ledger/v1/accounts`

Header `X-Gtad-Token`: the game's updater token, the same one its `/gtad` updater uses (HMAC of the project's PASSCODE). Body:
`{"name":"Leo"}` (control characters are removed and the name is cut to 24 characters).

`201 {"ok":true,"account":"a_…","secret":"…64 hex…","name":"Leo"}`. A missing or wrong token gets `401`. With no PASSCODE set,
the answer is `503`.

### `GET /ledger/v1/me`

`{"ok":true,"account","name","cash","imported":bool,"things":[{"thing","level","paid","since"}],"unlocks":["car_van",…],"seq"}`

### `GET /ledger/v1/world`

`{"ok":true,"accounts":[{"id","name","cash"}],"owners":[{"thing","account","level"}],"seq"}`. This is the whole town: draw the map,
the Chamber and Lillow from it.

### `GET /ledger/v1/feed?after=<seq>&limit=<1..500>`

`{"ok":true,"entries":[{"seq","at","batch","host","kind","account","other","thing","amount","why"}],"seq":<last seq returned>}`.
Poll it with the last `seq` to follow what happens anywhere in town. `kind` is one of `join import pay spend give buy sell upgrade
unlock transfer pass`. `amount` is signed, as seen from `account`. A give or transfer writes one line for each side.

### `POST /ledger/v1/commit`

This is how a host writes. Body: `{"batch":"<8 to 64 of A-Z a-z 0-9 _ ->","ops":[ … up to 64 … ]}`.

| op | fields | does |
|---|---|---|
| `pay` | `to, amount` | adds cash (job pay, the owner's cut, income) |
| `spend` | `from, amount` | takes cash (food, fuel) |
| `give` | `from, to, amount` | moves cash between two accounts |
| `buy` | `who, thing, price` | takes `price` and makes `who` the owner at level 0; the place must be unowned |
| `sell` | `who, thing, price` | `who` must own it; it becomes unowned and `who` gets `price` |
| `upgrade` | `who, thing, cost, level` | `who` must own it at `level - 1`; takes `cost`, sets `level` (1 to 9) |
| `unlock` | `who, unlock, price` | takes `price`, gives the unlock; `who` must not have it yet |
| `transfer` | `thing, from, to` | `from` must own it; it becomes `to`'s, keeping its level |
| `pass` | `unlock, from, to` | moves an unlock (a vehicle in a trade) |

Every op may add `"why"`, up to 80 characters, which the feed shows. A trade is one batch: its `transfer`, `pass` and `give` ops
land together or not at all.

- **All or nothing.** The whole batch is one D1 transaction. If any condition fails (short of cash, already owned, not the
  owner, wrong level, unknown account), nothing in the batch happens.
- **Once.** The pair (host account, `batch`) is applied once only. Sending the same batch again, for example after a timeout,
  gets `200 {"ok":true,"repeat":true,"first","entries","seq"}` and changes nothing. A new batch that is applied gets
  `201 {"ok":true,"repeat":false,"first":<its first seq>,"entries":<lines written>,"seq"}`.
- **Conflict.** `409 {"ok":false,"error":"conflict","op":<index>,"why":…}`. `why` is one of `owned` (with `thing` and `owner`),
  `short` (with `account`, `need` and `has`), `not the owner`, `wrong level` (with `level`), `has it`, `not theirs`,
  `no account` (with `account`), or `changed meanwhile` (the town moved while the batch was checked: rebuild it from `world` and
  send it again under a new batch id).
- **Bad shape.** `400 {"ok":false,"error":"bad request","op","why":<the field>}`.

Two hosts buying City Hall at the same moment: one gets `201`, the other gets `409 why:"owned"` and nothing is taken from its
buyer. The offline tests and `live.mjs` both cover this.

### `POST /ledger/v1/import`

This works once per account. Body: `{"cash":<n>,"things":[{"thing","level","paid"}],"unlocks":["…"]}` from the local save.

- Cash is capped at 50,000,000.
- Places someone else already owns in the global town stay theirs.
- The answer is `{"ok":true,"cash","kept":[…],"taken":[…]}`.
- A second import gets `409 "already imported"`.

### `POST /ledger/v1/name`

`{"name":"…"}` → `{"ok":true,"name"}`.

### `GET /ledger/v1/health`

`{"ok":true,"ledger":<bound>}`. This one is not signed.

## Trust

Hosts are the friends' own games, so the ledger trusts a signed host to describe what happened in its town: a job's pay, a
purchase, a trade both players confirmed. The ledger does not re-run the game's rules (prices, the 20 to 35 percent owner's cut).
It does enforce the following:

- Cash is never negative.
- A place has one owner.
- An unlock is held once per account.
- Upgrades go one level at a time.
- Batches are atomic and applied once.
- The ledger is append-only (a database trigger refuses any update or delete of its lines).

Accounts can be made only with the game's token.

## Setting it up (owner, once; nothing else about the site changes)

1. `wrangler d1 create gtad-ledger`
2. `wrangler d1 execute gtad-ledger --remote --file ledger/schema.sql`
3. In the Pages project `lewispolansky-static`, production settings, bind D1 database `gtad-ledger` as `LEDGER`. `PASSCODE` is
   already set for `/gtad`.
4. Merge the pull request. The next deploy serves `/ledger/v1/`.
5. Check it: `LEDGER_URL=https://lewispolansky.com LEDGER_CODE=<code> node ledger/test/live.mjs`. This makes four test
   accounts; ask before running it on the real town.
