# Lille Events Scraper Architecture

## Project Overview

Lille Events Scraper is an event aggregation service that:
1. Scrapes events from multiple configured official city websites using JinaAI
2. Aggregates and parses event data into structured format
3. Uses AI (Google Gemini) to generate personalized event recommendations based on user preferences

## Key Features

- **Multi-source support**: Configured to scrape from multiple event sources (currently Lille, extensible to other cities)
- **Concurrent fetching**: Fetches from multiple sources concurrently with rate limiting
- **Comprehensive logging**: Structured JSON logging throughout the application for debugging and monitoring
- **Database ready**: Prisma ORM configured with PostgreSQL for future data persistence
- **Streaming responses**: Server-Sent Events (SSE) for real-time progress updates to clients

## Directory Structure

```
Lille Events Scraper/
├── api/                          # Serverless API endpoints
│   └── gemini.js                 # POST /api/gemini - Main API handler
│
├── services/                     # Business logic services
│   ├── platformLookup.js         # Event fetching service (multi-source support)
│   └── geminiClient.js           # Gemini AI client wrapper
│
├── config/                       # Configuration files
│   └── companies.js              # Event sources configuration (extensible)
│
├── lib/                          # Utility functions and helpers
│   ├── logger.js                 # Structured logging module
│   ├── http.js                   # Fetch with JinaAI support and timeout
│   ├── validators.js             # Input validation helpers
│   ├── parsers.js                # Event data parsing
│   └── prismaClient.js           # Database client initialization and management
│
├── prisma/                       # Database configuration (Prisma ORM)
│   ├── schema.prisma             # Database schema
│   └── migrations/               # Database migrations
│
└── public/                       # Frontend assets
    ├── index.html                # Web UI
    └── README.md
```

## Core Workflows

### 1. Event Scraping Flow (Multi-source)

```
POST /api/gemini
    ↓
[Request Validation] - validators.js
    ↓
[Fetch Events from Multiple Sources] - platformLookup.js
    ├─→ Read enabled sources from config/companies.js
    ├─→ Fetch events concurrently (with rate limiting)
    │   ├─→ For each enabled source:
    │   ├─→ Use JinaAI to extract clean markdown content
    │   ├─→ Call https://r.jina.ai/{url}
    │   └─→ Log progress and results
    ├─→ Parse events using lib/parsers.js
    │   ├─→ Try markdown parsing first
    │   ├─→ Fallback to generic text parsing
    │   └─→ Aggregate events from all sources
    └─→ Return formatted events data with source metadata
    ↓
[Aggregate Events from All Sources]
    ├─→ Combine events from successful fetches
    ├─→ Track which sources succeeded/failed
    └─→ Format for AI prompt
    ↓
[Generate AI Response] - geminiClient.js
    ├─→ Call Gemini API with user prompt + event data
    └─→ Return personalized recommendations
    ↓
[Send SSE Response]
    └─→ Stream progress and results to client
```

### 2. Request Format

```json
POST /api/gemini
Content-Type: application/json

{
  "prompt": "I'm interested in concerts and outdoor activities"
}
```

### 3. Response Format (Server-Sent Events)

```
event: progress
data: {"type":"progress","data":{"state":"starting","sourceCount":2}}

event: progress
data: {"type":"progress","data":{"state":"fetching","source":"Lille Events"}}

event: progress
data: {"type":"progress","data":{"state":"found","source":"Lille Events","eventCount":45}}

event: result
data: {"type":"result","data":{"result":"...personalized recommendations...","raw":{...}}}

event: error (if failed)
data: {"type":"error","data":{"error":"Error message"}}
```

## Key Components

### API Route (api/gemini.js)
- HTTP POST endpoint handler
- Validates incoming payload with comprehensive error handling
- Orchestrates event fetching and AI generation
- Implements Server-Sent Events for streaming responses
- Comprehensive logging at all stages

### Platform Lookup Service (services/platformLookup.js)
- Fetches events from all enabled configured sources
- Manages concurrent requests with rate limiting
- Provides progress callbacks for real-time updates
- Handles failures gracefully with fallback to remaining sources
- Aggregates results from multiple sources
- Extensive logging for debugging

### Gemini Client (services/geminiClient.js)
- Wraps Google's Generative AI API
- Handles API authentication and error handling
- Configurable model selection via environment variables
- Comprehensive error logging

### Event Parsers (lib/parsers.js)
- Markdown parsing (optimized for JinaAI extracted content)
- Generic text parsing (fallback for unstructured content)
- Event validation and filtering
- Detailed logging of parsing process

### HTTP Utilities (lib/http.js)
- Timeout-enabled fetch wrapper
- JinaAI integration for content extraction
- Automatic User-Agent and header management

### Input Validators (lib/validators.js)
- Payload validation with error logging
- Type checking and format validation
- Clear error messages

### Logger (lib/logger.js)
- Structured JSON logging
- Context-aware logging with scoped loggers
- Multiple log levels (INFO, ERROR, WARN, DEBUG)
- Automatic timestamp and formatting

### Prisma Client (lib/prismaClient.js)
- Lazy initialization of Prisma client
- Connection status tracking
- Query logging support
- Maintained for future database operations

## Configuration

### Event Sources (config/companies.js)

Event sources are configured with:
```javascript
{
  name: 'Display name',
  source: 'Organization name',
  url: 'https://example.com/events',
  parser: 'jina',
  timeout: 10000,
  enabled: true,
  description: 'Source description'
}
```

**Currently Enabled Sources:**
- Lille Events: https://www.lille.fr/Evenements/

**Disabled but Configured (ready to enable):**
- Lille Events Page 2 and 3 (pagination support)

**Templates Available (commented out):**
- Paris Events
- Brussels Events
- Antwerp Events

**To Add New Sources:**
1. Add configuration object to `config/companies.js`
2. Set `enabled: true`
3. The system will automatically include it in lookups

### Environment Variables

```bash
# Gemini API Configuration
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-3.5-flash  # Optional, defaults to gemini-3.5-flash

# Database Configuration (Prisma)
POSTGRES_PRISMA_URL=postgresql://user:password@host/dbname
POSTGRES_URL_NON_POOLING=postgresql://user:password@host/dbname

# Development
NODE_ENV=production|development  # Default: production
DEBUG=true|false  # Enable debug logging
RETURN_DEBUG_PROMPT=true|false  # Return constructed prompt instead of calling API
ALLOW_INSECURE_TLS=true|false  # Allow insecure TLS in development (default: false)
```

## Logging

The application uses structured JSON logging throughout:

```json
{
  "timestamp": "2026-06-02T10:30:45.123Z",
  "level": "INFO",
  "context": "services/platformLookup",
  "message": "Lookup starting",
  "data": { "sourceCount": 2 }
}
```

**Log Levels:**
- **INFO**: Normal operation milestones
- **WARN**: Non-critical issues (failed source, empty results)
- **ERROR**: Critical failures (API errors, validation errors)
- **DEBUG**: Detailed diagnostic information (only in development)

## Database Integration

Prisma ORM is configured but not actively used yet. It's ready for:
- Storing scraped events
- Caching results
- Tracking user preferences
- Analytics and monitoring

Database schema includes:
- `Platform` model for event sources
- `Company` model for organizations
- Ready to extend with `Event`, `User`, `Recommendation` models

## Extending the System

### Adding a New Event Source
1. Add configuration to `config/companies.js`
2. Set `enabled: true`
3. Optionally customize parser if needed
4. System automatically picks it up on next request

### Modifying Event Parser
1. Update parsing logic in `lib/parsers.js`
2. Add logging for debugging
3. Extend event object structure if needed

### Adding Database Features
1. Update `prisma/schema.prisma` with new models
2. Run `prisma migrate dev --name <migration_name>`
3. Use `lib/prismaClient.js` to access database
4. Add logging for queries

### Adding New AI Features
1. Create new service in `services/`
2. Use existing patterns for logging and error handling
3. Wire into `api/gemini.js` handler

## Performance Considerations

- **Concurrent Fetching**: Max 3 concurrent requests per batch to avoid overwhelming sources
- **Event Limit**: Truncated to 50 events in AI prompt for token efficiency
- **Total Event Extraction**: Limited to 200 events per source
- **Timeouts**: 8-10 seconds per source fetch, 200 seconds for AI generation
- **Response Streaming**: SSE allows real-time progress updates without blocking
- Orchestrates platform lookup and AI generation
- Streams results via Server-Sent Events (SSE)

### Platform Lookup Service (services/platformLookup.js)
- **Purpose**: Search for job postings across multiple recruitment platforms
- **Key Functions**:
  - `lookupSlugs()` - Main entry point for company searches
  - `processSlug()` - Process individual company
  - `probeUrl()` - Test URL availability and validity
- **Features**:
  - Batch processing with configurable concurrency
  - Rate-limit aware (delays between batches)
  - Progress callbacks for streaming updates
  - Automatic platform detection from config

### Job Parsers (lib/parsers.js)
- Extracts job offers from different recruitment platform formats
- **Supported Formats**:
  - **JSON APIs**: SmartRecruiters, Workable, TalentView
  - **RSS Feeds**: Teamtailor
  - **Fallback**: Generic text extraction
- **Output**: Normalized job offer objects with title, location, URL, company

### Company Configuration (config/companies.js)
- Centralized registry of recruitment platforms and their APIs
- Organized by platform type for easy maintenance
- Each entry contains:
  - `platform`: Platform name (SmartRecruiters, Workable, Teamtailor, TalentView)
  - `url`: API endpoint URL with query parameters

### Gemini Client (services/geminiClient.js)
- Wrapper around Google's Generative AI API
- Handles authentication via `GEMINI_API_KEY` environment variable
- Configurable model selection (default: `gemini-3.5-flash`)
- Parses and normalizes API responses

## Platform Support Details

### SmartRecruiters
- **Type**: JSON REST API
- **Response Format**: `{ content: [...] }` containing job postings
- **Features**: Supports geographic filtering (country, region)

### Workable
- **Type**: JSON REST API
- **Response Format**: `{ jobs: [...] }`
- **Features**: Widget API for candidate tracking

### Teamtailor
- **Type**: RSS Feed
- **Response Format**: Standard RSS XML with custom `<tt:city>`, `<tt:country>` tags
- **Features**: Location metadata in RSS items

### TalentView
- **Type**: Custom JSON API
- **Response Format**: Array or `{ data: [...] }`
- **Features**: Location-based search with coordinates

## Configuration

### Environment Variables

```bash
# Required
GEMINI_API_KEY=<your-google-gemini-api-key>

# Optional
GEMINI_MODEL=gemini-3.5-flash           # AI Model to use
NODE_ENV=production                      # Environment
ALLOW_INSECURE_TLS=false                # For local dev with TLS issues
```

### Request Options

**Company Lookup** (via `lookupSlugs`):
- `timeout`: Request timeout (default: 8000ms)
- `concurrency`: Max concurrent requests per batch (default: 2)
- `onProgress`: Callback function for progress updates
- `showProgress`: Log progress to console if no onProgress

**AI Generation** (via `generateContent`):
- `timeout`: API timeout (default: 20000ms)

## Data Flow Example

1. Client sends POST to `/api/gemini`
2. API validates prompt is present
3. If `companies` provided:
   - Normalize company slugs (handle arrays or newline-separated strings)
   - Process in batches (e.g., 3 concurrent with 300ms delay between batches)
   - For each company:
     - Look up in predefined configuration
     - Probe URL (GET request with timeout)
     - Validate response content (must be > 100 characters)
     - Parse job offers (JSON or RSS)
     - Send progress events via SSE
   - Accumulate all job offers
   - Append to prompt
4. Generate AI response:
   - Call Gemini API with enhanced prompt
   - Parse response
   - Stream result via SSE
5. Send final SSE event and close stream

## Error Handling

### Validation Errors
- Missing or empty prompt → 400 Bad Request
- Wrong HTTP method → 405 Method Not Allowed

### Lookup Errors
- Company not found → Reported in results but doesn't fail request
- URL probe fails → Logged but continues with other companies
- Network errors → Included in error messages but don't stop processing

### API Errors
- Timeout → Caught and reported via error event
- Invalid response → Raw body included in error for debugging
- Authentication → Clear error message with status code

## Testing

### Local Development

1. Set environment variables:
```bash
export GEMINI_API_KEY=test-key
export NODE_ENV=development
export ALLOW_INSECURE_TLS=true
```

2. Test with curl:
```bash
curl -X POST http://localhost:3000/api/gemini \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Find jobs",
    "companies": ["kiabi", "exotec"]
  }' \
  --no-buffer
```

3. The response will include:
- Progress events for each company lookup
- Final result with constructed prompt (debug mode) or AI response
- Any errors encountered during processing

## Performance Considerations

1. **Batch Processing**: Companies are processed in configurable batches to:
   - Avoid overwhelming remote servers
   - Prevent rate limiting
   - Allow cancellation of batch while others process

2. **Timeouts**: 
   - Company probes: 8000ms (short, just need validation)
   - AI API: 20000ms (longer, may take time)

3. **Concurrent Limits**:
   - Default: 2 concurrent requests per batch
   - Can be increased for parallel processing
   - Batch delays (300ms) prevent rate limiting

4. **Content Caching**: (Future enhancement)
   - Cache company URLs and responses
   - Only re-probe if data is stale
   - Reduce API calls to recruitment platforms

## Future Enhancements

1. **Database Integration** (Prisma ready):
   - Store company information
   - Cache job postings
   - Track lookup history

2. **Authentication**:
   - API key validation for clients
   - Rate limiting per user
   - Request tracking

3. **Advanced Filtering**:
   - Location-based filtering
   - Job level filtering (junior, senior, etc.)
   - Technology stack filtering

4. **Additional Platforms**:
   - LinkedIn API
   - Indeed API
   - Custom RSS feeds

5. **UI/Dashboard**:
   - Job search interface
   - Results visualization
   - Saved searches

```
