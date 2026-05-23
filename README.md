Run the local backend + front-end (development):

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

Then open http://localhost:3000 in your browser. The front-end will call the backend `/api/chat` endpoint which forwards messages to the OpenAI API. Keep your API key secret (do not commit `.env`).

RAG & mémoire (embeddings + SQLite)

1. Add your `OPENAI_API_KEY` to `.env`.
2. The server now stores documents and messages in `server_data.db` (SQLite) and exposes endpoints:
	- `POST /api/docs` { content, sessionId } -> stores a document and its embedding
	- `POST /api/search` { query, topK } -> returns nearest documents
	- `POST /api/chat` uses RAG to include top documents in the system prompt

Usage: add documents either via the endpoint or extend the front-end UI to allow users to upload documents for better, context-aware responses.


# admia-app
En moins de 350 caractères (idéal pour GitHub) :  Admia est un assistant administratif intelligent sous forme de chat. Conçu pour simplifier la paperasse, il aide à rédiger des courriers officiels, analyser des contrats et décoder des formulaires. L'application intègre un système d'abonnement simulé (Paywall).
