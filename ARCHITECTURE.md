```
# JobFinder Architecture

## Project Overview

JobFinder is a job aggregation service that:
1. Searches multiple recruitment platforms for job postings
2. Aggregates results with company information
3. Uses AI (Google Gemini) to generate insights or answers based on job data

## Directory Structure

```
JobFinder/
├── api/                          # Serverless API endpoints
│   └── gemini.js                 # POST /api/gemini - Main API handler
│
├── services/                     # Business logic services
│   ├── platformLookup.js         # Platform job search service
│   └── geminiClient.js           # Gemini AI client wrapper
│
├── config/                       # Configuration files
│   └── companies.js              # Predefined company platform configs
│
├── lib/                          # Utility functions
│   ├── http.js                   # Fetch with timeout support
│   ├── validators.js             # Input validation helpers
│   └── parsers.js                # Job offer parsing for different formats
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

### 1. Job Posting Lookup Flow

```
POST /api/gemini
    ↓
[Request Validation]
    ↓
[Optional: Company Job Search]
    ├─→ platformLookup.lookupSlugs()
    ├─→ Normalize company slugs
    ├─→ Process in batches (to avoid rate limits)
    │   ├─→ probeUrl() - Test each company's URL
    │   ├─→ Validate response content
    │   └─→ Parse job offers (JSON/RSS)
    ├─→ extractOffersFromBody() - Platform-specific parsing
    │   ├─→ JSON parsing (SmartRecruiters, Workable, TalentView)
    │   ├─→ RSS parsing (Teamtailor)
    │   └─→ Fallback generic text extraction
    └─→ Return formatted results + accumulated job data
    ↓
[Generate AI Response (optional)]
    ├─→ generateContent() - Call Gemini API
    └─→ Stream results via Server-Sent Events
    ↓
[Send SSE Response]
    └─→ event: 'progress', 'result', 'error'
```

### 2. Request Format

```json
POST /api/gemini
Content-Type: application/json

{
  "prompt": "Find senior developer jobs in the region",
  "companies": [
    "kiabi",
    "exotec",
    "ankama"
  ]
}
```

### 3. Response Format (Server-Sent Events)

```
event: progress
data: {"type":"progress","data":{"slug":"kiabi","state":"looking","platform":"auto-detect"}}

event: progress
data: {"type":"progress","data":{"slug":"kiabi","state":"found","platform":"SmartRecruiters","url":"https://..."}}

event: result
data: {"type":"result","data":{"result":"...generated content...","raw":{...}}}

event: error (if failed)
data: {"type":"error","data":{"error":"Error message"}}
```

## Key Components

### API Route (api/gemini.js)
- HTTP POST endpoint handler
- Validates incoming payload
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
