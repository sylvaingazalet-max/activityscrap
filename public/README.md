# JobFinder AI

JobFinder is an automated tool designed to streamline the job search process by matching user profiles with live job openings using advanced AI.

## How It Works

The application follows a two-step intelligent workflow:

### 1. Job Data Extraction (Stage 1)
The application identifies job openings via curated company checkboxes (Kiabi, Exotec, Lesaffre) or custom company slugs.
- It utilizes **Jina AI** (Reader API) and specialized platform lookups (SmartRecruiters, Greenhouse, Lever, etc.) to fetch the latest job postings.
- It crawls these pages to extract a clean summary of open positions, removing the "noise" of standard web navigation and focus purely on the job content.

### 2. Intelligent Comparison (Stage 2)
Once the job data is collected, it is passed to **Google Gemini AI** (Gemini 2.5 Flash).
- **Context Injection**: The extracted job summaries are appended to the user's specific request or profile.
- **Matching Logic**: Gemini performs a semantic comparison between the user's skills, experience, and preferences and the actual requirements of the open roles.
- **Output**: The user receives a curated list of recommendations explaining *why* certain positions are a good fit.

## Technical Stack
- **Backend**: Node.js (Vercel Serverless Functions)
- **AI Models**: Google Gemini 2.5 Flash
- **Extraction**: Jina AI & Custom Platform Probes
- **Communication**: Server-Sent Events (SSE) for real-time progress tracking