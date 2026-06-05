# Lille Events - System Architecture

## Project Overview

Lille Events is an AI-powered event discovery and recommendation service that:
1. Reads structured events and high-dimensional semantic vector embeddings from a PostgreSQL database using Prisma ORM.
2. Uses Google Gemini AI to analyze natural language user prompts and extract structured search constraints (e.g., date ranges, neighborhoods, pricing).
3. Executes semantic similarity queries using `pgvector` alongside metadata filters to find the best matched events.
4. Generates highly personalized, tailored recommendations explaining why the matching events align with user preferences.
5. Employs Server-Sent Events (SSE) to stream real-time progression and recommendation outputs to the web client.

---

## System Components

### 1. API Endpoint Handler (`api/gemini.js`)
- **Filter Extraction**: Sends the user's natural language input to `gemini-2.5-flash` to return a strictly structured JSON object containing start/end dates, neighborhoods, pricing constraints, age limits, and event types.
- **Database Query Orchestrator**: Uses Prisma to query the database.
- **AI Recommendation generation**: Forwards matched event metadata to the Gemini API (`generateContent`) along with the user prompt.
- **SSE Streamer**: Sets headers to `text/event-stream` and streams chunked JSON progress events (`progress`, `result`, `error`) to the client.

### 2. Gemini Client (`services/geminiClient.js`)
- Standardized fetch client wrapper for Google Gemini's `generateContent` API endpoint.
- Features custom HTTP timeout management and comprehensive raw JSON/text response parser structures.

### 3. Embeddings Script (`scripts/generate-embeddings.js`)
- **Data Context Builder**: Aggregates event titles, chapôs (subtitles), descriptions, event types, and neighborhood names into a unified descriptive text paragraph.
- **Sequential Embedder**: Uses Gemini's `gemini-embedding-2` model to produce 768-dimensional vector representations.
- **PGVector Updater**: Safe BigInt-to-string conversion and updates database records using Raw SQL.
- **Rate-limit Aware**: Employs exponential backoffs on `429` status codes and pauses for 2 seconds between batch offsets (50 events/batch).

### 4. Database Schema (`prisma/schema.prisma`)
- Modelled on Lille's municipal events dataset.
- Integrates metadata attributes (such as dates, prices, addresses, neighborhoods, and categories) alongside a custom PostgreSQL `pgvector` column defined as `embedding Unsupported("vector")?`.

---

## Information Flow

