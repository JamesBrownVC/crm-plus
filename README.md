# CRM+

A local relationship manager for keeping track of people, companies, conversations, follow-ups and opportunities. CRM+ runs on your computer and opens in your browser. It starts empty and is designed for one person.

## Run from source

Use **Node.js 24 or newer**. The app has no third-party runtime dependencies, so no `npm install` is needed.

```bash
git clone https://github.com/JamesBrownVC/crm-plus.git
cd crm-plus
node server.js
```

Open the address printed in the terminal, normally <http://127.0.0.1:8788>. On first launch, choose your display name and set a local password. Keep the terminal open while using the app; stop it with `Ctrl+C` when finished.

You can also download the source from the repository's **Code → Download ZIP** menu.

### Windows portable package

See [Releases](https://github.com/JamesBrownVC/crm-plus/releases) for available downloads. A Windows portable release is named **`CRMPlus-portable.zip`** and includes its own Node runtime. Extract it and follow its `README.txt`; a separate Node installation is not needed for that package.

## What it does

- **Contacts and companies:** keep notes, tags, roles and relationship history together. Maintain a focused roster alongside a larger imported network.
- **Activity and follow-ups:** log conversations, record promises, set due dates and review overdue items.
- **Relationship warmth:** see a configurable score based on recorded recency, frequency, reciprocity and other signals, with an explanation of the calculation.
- **Opportunity pipeline:** track stages, priorities and next steps for company-level opportunities.
- **Weekly planning:** rank suggested actions within a time budget using configured priorities and effort estimates.
- **Network search:** filter people against criteria you choose and inspect which fields support a match.
- **LinkedIn import:** import connections and message history from your own export.

The optional **People → Suggested** view uses a title-based starter profile. No employer, school, sector or geography preferences are supplied. Review each suggestion yourself, or use **Network → Find matches** to define and save your own matching criteria.

## Import your LinkedIn export

In **Settings → Import from LinkedIn**, select an exported ZIP or supply the supported CSV files. The importer looks for:

| File | Imported information |
| --- | --- |
| `Connections.csv` | Contact names, profile links, roles and companies, plus email addresses when present. A connection alone does not count as a conversation. |
| `messages.csv` | Dated inbound and outbound activity for recognized contacts. Group threads and drafts are skipped. |

Repeat imports skip already recorded connections and messages using the importer's matching rules. This is not a general-purpose duplicate merge tool.

Sector, company stage, geography and other details may be absent from an export. Add missing information before relying on criteria that use those fields. External profile links open the corresponding website when you choose them.

## Your data and backups

CRM+ stores application data in a local SQLite database. It requires no cloud account or hosted service.

| How you run it | Default database location |
| --- | --- |
| Source checkout | `data/crm.db` inside the project folder |
| Windows portable launcher | `%APPDATA%\CRMPlus\crm.db` |
| Packaged macOS app | `~/Library/Application Support/CRMPlus/crm.db` |
| Packaged Linux app | `$XDG_DATA_HOME/CRMPlus/crm.db`, or `~/.local/share/CRMPlus/crm.db` |

To back up, **stop the app cleanly**, then copy the database to a safe location. If SQLite sidecar files (`crm.db-wal` or `crm.db-shm`) remain, keep them with the database. Restore a backup only while the app is stopped. There is no automatic backup or cloud synchronization.

The repository excludes databases, common LinkedIn exports and local evaluation datasets through `.gitignore`. Keep your imports, backups and any other private files outside material you publish. `.gitignore` does not remove information already committed to Git.

### Optional configuration

Set environment variables before starting the app:

| Variable | Purpose |
| --- | --- |
| `CRM_PLUS_DB_PATH` | Use an explicit database path instead of the default. |
| `CRM_PLUS_OPEN_BROWSER=1` | Open the local app in a browser on launch. |
| `PORT` | Choose the starting port; the default is `8788`. |
| `CRM_PLUS_NO_AUTH=1` | Skip the local password gate for development or an isolated local session. |
| `CRM_PLUS_ME_NAME` | Set the placeholder identity used when the password gate is disabled. |

The server binds to `127.0.0.1`. The local password gate is not a multi-user permission system. CRM+ is not designed to be exposed as a shared internet service.

## How to interpret the scores

Scores summarize the information recorded in the app. Missing conversations, stale roles or incomplete records can change the result substantially.

- **Warmth** combines activity signals using configurable weights and decay. It does not establish how someone feels about the relationship.
- **Criteria fit** evaluates recorded fields against weighted criteria you provide; missing fields limit what it can assess.
- **Suggested contacts** use explicit role keywords by default. Company, domain and exclusion rule lists start empty. The displayed score is a ranking aid, not a calibrated probability.
- **Action planning** uses hand-set assumptions and priorities. It does not predict revenue or guarantee an outcome.

Review the explanations and settings before relying on a score. The evaluation scripts can help inspect performance against your own labels; no private datasets or claimed benchmark results are included.

## Development

```bash
npm test
```

Run the test suite before submitting changes. Tests create their own fixtures.

```bash
node build.mjs
```

The build script creates a portable folder and an executable for the build machine's platform. Building downloads development tools through `npx` and requires internet access. Produce the Windows portable ZIP on Windows; build outputs are written under `dist/` and are not committed.

| Location | Purpose |
| --- | --- |
| `server.js`, `api.js` | Local HTTP server, authentication and application endpoints |
| `db.js`, `packaging.js` | Database schema, settings and storage paths |
| `engines/` | Relationship scoring, matching and action planning |
| `public/` | Browser interface |
| `tests/` | Automated tests and generated fixtures |
| `eval/`, `evaluate-icp.mjs` | Optional local scoring evaluation tools |

Multi-user access, shared permissions and synchronization would require additional design and implementation. The multi-hop introduction-path interface is disabled because imported connections do not establish relationships between other people.

## License and provenance

CRM+ is available under the [MIT License](LICENSE), including commercial use and modification under its terms.

Parts of the scoring and planning engines were adapted from the Net-Work/ACR project. They are included here under the same MIT license with the source owner's authorization.
