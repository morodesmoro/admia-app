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

# admia-app
En moins de 350 caractères (idéal pour GitHub) :  Admia est un assistant administratif intelligent sous forme de chat. Conçu pour simplifier la paperasse, il aide à rédiger des courriers officiels, analyser des contrats et décoder des formulaires. L'application intègre un système d'abonnement simulé (Paywall).
