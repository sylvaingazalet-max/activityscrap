# Lille Events Scraper

An event aggregation service that scrapes events from Lille official website, parses event data, and uses AI to help users discover events tailored to their preferences.

## Quick Start

### Prerequisites

- Node.js 16+ (for AbortController support)
- Google Gemini API key
- JinaAI API (for content extraction)

### Installation

```bash
npm install
```

### Configuration

Set environment variables in `.env`:

```env
# Required
GEMINI_API_KEY=your-google-gemini-api-key

# Optional
GEMINI_MODEL=gemini-3.5-flash
NODE_ENV=development
```

### Running Locally

```bash
# Development server (example using Vercel Functions)
npm run dev

# Or manually start the endpoint
node api/gemini.js
```

## API Usage

### POST /api/gemini

Search for events in Lille and generate AI-powered personalized recommendations.

**Request:**

```bash
curl -X POST http://localhost:3000/api/gemini \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "I'm interested in concerts and outdoor events"
  }' \
  --no-buffer
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | ✓ | User preferences or interests for event recommendations |

**Response (Server-Sent Events):**

The API streams responses as Server-Sent Events:

```
event: progress
data: {"type":"progress","data":{"state":"fetching","source":"Lille Events"}}

event: progress
data: {"type":"progress","data":{"state":"found","eventCount":45}}

event: result
data: {"type":"result","data":{"result":"...personalized recommendations..."}}

event: error (if applicable)
data: {"type":"error","data":{"error":"..."}}
```

## Data Source

The system scrapes events from the official Lille city website:

- **Source**: https://www.lille.fr/Evenements/

### Adding New Companies

1. Identify the recruitment platform they use
2. Get their API endpoint URL
3. Add entry to [config/companies.js](config/companies.js):

```javascript
mycompany: {
  platform: 'SmartRecruiters',  // or other platform
  url: 'https://api.example.com/...'
}
```

## Project Structure

```
JobFinder/
├── api/                    # API endpoints
│   └── gemini.js          # Main endpoint handler
├── services/              # Business logic
│   ├── platformLookup.js  # Job search service
│   └── geminiClient.js    # AI client
├── config/                # Configuration
│   └── companies.js       # Company registry
├── lib/                   # Utilities
│   ├── http.js           # Fetch with timeout
│   ├── validators.js     # Input validation
│   └── parsers.js        # Job parsing
└── ARCHITECTURE.md        # Detailed architecture docs
```

## How It Works

1. **Validation**: Incoming request is validated for required fields
2. **Lookup**: Each company slug is processed:
   - URL is probed to verify job postings are available
   - Response content is validated
   - Job offers are parsed (platform-specific)
3. **Aggregation**: All offers are collected and formatted
4. **AI Generation** (optional):
   - Enhanced prompt is sent to Gemini API
   - Response is streamed back to client

## Development

### Code Organization

- **api/**: HTTP handlers, SSE response management
- **services/**: Business logic (lookups, AI calls)
- **lib/**: Reusable utilities (HTTP, parsing, validation)
- **config/**: Static configuration (company registry)

### Adding New Features

1. **New Parser Format**: Add to [lib/parsers.js](lib/parsers.js)
2. **New Validation**: Add to [lib/validators.js](lib/validators.js)
3. **New Platform**: Add entry to [config/companies.js](config/companies.js)
4. **Database Integration**: Modify with Prisma (already configured)

### Code Style

- JSDoc comments for all functions
- Descriptive variable names
- Section headers for logical grouping
- Inline comments explaining complex logic
- Error messages in English

## Troubleshooting

### Timeout Issues

If requests timeout frequently:

```javascript
// Increase timeout in api/gemini.js
const COMPANY_LOOKUP_CONFIG = {
  timeout: 12000  // Increase from 8000
};
```

### TLS Certificate Errors (Development)

Enable insecure TLS for local testing:

```bash
export ALLOW_INSECURE_TLS=true
export NODE_ENV=development
```

### Company Not Found

Verify the company slug is in [config/companies.js](config/companies.js). Company slugs are lowercase.

### Empty Job Results

Some platforms may require specific headers or may block requests. Check:
1. Is the platform API still accessible?
2. Are there rate limiting issues?
3. Check logs for detailed error messages

## Performance Tips

1. **Batch Size**: Adjust concurrency based on your needs
   - Lower concurrency (1-2): More stable, slower
   - Higher concurrency (5+): Faster, may hit rate limits

2. **Timeout Values**: Balance between responsiveness and reliability
   - Short (5000ms): May timeout legitimate requests
   - Long (30000ms): Better reliability, slower overall

3. **Caching** (Future):
   - Results are not cached currently
   - Consider implementing Redis caching

## Database

The project includes Prisma ORM configured. Current schema includes:
- Database migrations in `prisma/migrations/`
- Schema in `prisma/schema.prisma`

To extend with data storage:

```bash
npx prisma migrate dev --name "add_jobs_table"
```

## License

ISC

## Contributing

1. Keep comments in English
2. Document new functions with JSDoc
3. Group related functions with section headers
4. Test timeout scenarios
5. Update ARCHITECTURE.md for structural changes

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - Detailed system architecture
- [Gemini API Docs](https://ai.google.dev/docs)
- [Prisma Docs](https://www.prisma.io/docs/)
