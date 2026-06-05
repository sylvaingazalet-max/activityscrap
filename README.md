# Lille Events - AI-Powered Recommendation System

This project is an AI-powered event discovery and recommendation system based on events published by the Lille City Hall. The user enters their prompt, and thanks to a database-driven semantic vector search system and metadata filters, we search for and recommend all matching events.

---

## 📖 Project Overview

Users can enter natural language prompts (e.g., *"I'm looking for a free concert to attend with friends this Saturday night"*). The application performs the following:
1. **Filter Extraction**: Analyzes the user's prompt using **Gemini 2.5 Flash** to extract structured metadata filters (start/end dates, specific neighborhoods in Lille, pricing, age limits, event types).
2. **Database Querying & Filtering**: Queries a PostgreSQL database managed via **Prisma ORM** to find events matching the extracted filters.
3. **AI Recommendation**: Passes the matched events and original user prompt to **Gemini** to generate personalized event suggestions.
4. **Streaming Results**: Streams responses back to the user in real-time using **Server-Sent Events (SSE)**.

---

## 🛠️ Project Structure

- **`api/gemini.js`**: Main serverless endpoint handler. Handles incoming POST requests, extracts filters with Gemini, queries Prisma for events, invokes the recommendation engine, and streams SSE results.
- **`services/geminiClient.js`**: Wrapper for Google Gemini content generation.
- **`scripts/generate-embeddings.js`**: A batch-processing script that reads events with missing embeddings, constructs descriptive text contexts, generates 768-dimension vectors via Google Gemini's `gemini-embedding-2` model, and saves them to PostgreSQL with robust rate limiting.
- **`lib/`**:
  - `prismaClient.js`: Dynamically initializes and exposes the Prisma client instance.
  - `validators.js`: Payload validators verifying that user prompts are valid.
  - `logger.js`: Structured JSON logger providing distinct context and formatting.
  - `http.js`: General HTTP fetch client with custom timeout controls.
- **`prisma/schema.prisma`**: Schema for the `events` table including metadata columns and an unsupported `vector` column mapping pgvector.
- **`public/index.html`**: A lightweight, clean frontend web interface to prompt and stream suggestions directly.

---

## 🚀 Quick Start & Installation

### 1. Install Dependencies

