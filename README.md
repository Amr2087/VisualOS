# VisualOS

AI photoshoot generator — describe your shots, pick a style, and generate images via Google Gemini.

## Setup

**1. Clone and create a virtual environment**
```bash
git clone <repo-url>
cd VisualOS
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
```

**2. Install dependencies**
```bash
pip install -r backend/requirements.txt
```

**3. Add your Gemini API key**
```bash
cp .env.example .env
# then edit .env and paste your key
```

Get a free key at [aistudio.google.com](https://aistudio.google.com/app/apikey).

**4. Run**
```bash
streamlit run app.py
```

Opens at `http://localhost:8501`.

## Usage

- **Create tab** — pick styles + settings, add one or more shot descriptions, optionally upload reference images per shot (enables edit/compose mode), then click **Generate shoot**.
- **Library tab** — browse all saved shots.

## Models used

| Node | Model |
|---|---|
| Prompt refinement | `gemini-3-flash-preview` |
| Image generation | `gemini-3.1-flash-image-preview` |
