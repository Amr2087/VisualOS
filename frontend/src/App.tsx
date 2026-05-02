import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, ImagePlus, Loader2, Sparkles, Upload } from "lucide-react";

type StyleOption = {
  label: string;
  subtitle?: string;
  description?: string;
};

type ConfigCategory = {
  label: string;
  description: string;
  options: Record<string, StyleOption>;
};

type StyleConfig = {
  photoshootConfig: Record<string, ConfigCategory>;
};

type GenerateResult = {
  refined_prompt: string;
  reference_mapping: string;
  mime_type: string;
  image_base64: string;
};

type FileWithRelativePath = File & {
  webkitRelativePath?: string;
};

const fieldLabels: Record<string, string> = {
  style_genre: "Style / Genre",
  moodboard_grading: "Moodboard / Grading",
  framing: "Framing",
  camera_angle: "Camera Angle",
  lens_focal_length: "Lens / Focal Length",
  lighting_setup: "Lighting Setup",
  environment_setting: "Environment"
};

const defaultPrompt =
  "Create a full-body editorial fashion image. Use (model) as the person reference and use the product references as the wardrobe pieces. Preserve the products' shapes, materials, colors, and styling details while creating a realistic premium photoshoot.";

const folderUploadProps = { webkitdirectory: "" };

function stemName(file: FileWithRelativePath) {
  const filename = file.webkitRelativePath || file.name;
  const clean = filename.split("/").pop() || filename;
  return clean.replace(/\.[^.]+$/, "");
}

function SelectField({
  id,
  category,
  value,
  onChange
}: {
  id: string;
  category: ConfigCategory;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{fieldLabels[id] || category.label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(category.options).map(([key, option]) => (
          <option key={key} value={key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FileList({ title, files }: { title: string; files: FileWithRelativePath[] }) {
  if (!files.length) return null;

  return (
    <div className="file-list">
      <div className="file-list-title">{title}</div>
      {files.map((file) => (
        <div className="file-row" key={`${file.name}-${file.lastModified}`}>
          <span>({stemName(file)})</span>
          <small>{file.webkitRelativePath || file.name}</small>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<StyleConfig | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [engineParams, setEngineParams] = useState("{}");
  const [size, setSize] = useState("1K");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [modelFiles, setModelFiles] = useState<FileWithRelativePath[]>([]);
  const [productFiles, setProductFiles] = useState<FileWithRelativePath[]>([]);
  const [folderFiles, setFolderFiles] = useState<FileWithRelativePath[]>([]);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((data: StyleConfig) => {
        setConfig(data);
        const nextSettings: Record<string, string> = {};
        Object.entries(data.photoshootConfig).forEach(([key, category]) => {
          nextSettings[key] = Object.keys(category.options)[0];
        });
        setSettings(nextSettings);
      })
      .catch(() => setError("Could not load style_config.json from the API."));
  }, []);

  const referenceNames = useMemo(
    () => [...modelFiles, ...productFiles, ...folderFiles].map((file) => stemName(file)),
    [modelFiles, productFiles, folderFiles]
  );

  const imageSrc = result ? `data:${result.mime_type};base64,${result.image_base64}` : "";

  function onFiles(setter: (files: FileWithRelativePath[]) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setter(Array.from(event.target.files || []) as FileWithRelativePath[]);
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!prompt.trim()) {
      setError("Add a prompt before generating.");
      return;
    }

    try {
      JSON.parse(engineParams || "{}");
    } catch {
      setError("Engine params must be valid JSON.");
      return;
    }

    const form = new FormData();
    form.append("initial_prompt", prompt);
    form.append("size", size);
    form.append("aspect_ratio", aspectRatio);
    form.append("engine_params", engineParams || "{}");
    Object.entries(settings).forEach(([key, value]) => form.append(key, value));
    modelFiles.forEach((file) => form.append("model_images", file, file.name));
    productFiles.forEach((file) => form.append("product_images", file, file.name));
    folderFiles.forEach((file) => form.append("reference_images", file, file.name));

    setIsGenerating(true);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        body: form
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Generation failed.");
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>VisualOS</h1>
          <p>LangGraph Gemini photoshoot agent</p>
        </div>
        <div className="status-pill">Session only</div>
      </section>

      <form className="workspace" onSubmit={submit}>
        <section className="left-pane">
          <div className="surface">
            <div className="section-heading">
              <Sparkles size={18} />
              <h2>Prompt</h2>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={10}
              placeholder="Reference (model), (product1), and (product2) by filename stem."
            />
            {referenceNames.length > 0 && (
              <div className="reference-tags">
                {referenceNames.map((name) => (
                  <span key={name}>({name})</span>
                ))}
              </div>
            )}
          </div>

          <div className="surface">
            <div className="section-heading">
              <FolderOpen size={18} />
              <h2>References</h2>
            </div>
            <div className="upload-grid">
              <label className="upload-box">
                <ImagePlus size={20} />
                <span>Model images</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onFiles(setModelFiles)} />
              </label>
              <label className="upload-box">
                <Upload size={20} />
                <span>Product images</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onFiles(setProductFiles)} />
              </label>
              <label className="upload-box">
                <FolderOpen size={20} />
                <span>Reference folder</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={onFiles(setFolderFiles)}
                  {...folderUploadProps}
                />
              </label>
            </div>
            <FileList title="Model" files={modelFiles} />
            <FileList title="Product" files={productFiles} />
            <FileList title="Folder" files={folderFiles} />
          </div>
        </section>

        <section className="right-pane">
          <div className="surface">
            <div className="section-heading">
              <h2>Image Settings</h2>
            </div>
            <div className="settings-grid">
              {config &&
                Object.entries(config.photoshootConfig).map(([key, category]) => (
                  <SelectField
                    key={key}
                    id={key}
                    category={category}
                    value={settings[key] || ""}
                    onChange={(value) => setSettings((current) => ({ ...current, [key]: value }))}
                  />
                ))}
              <label className="field">
                <span>Size</span>
                <select value={size} onChange={(event) => setSize(event.target.value)}>
                  <option value="1K">1K</option>
                  <option value="2K">2K</option>
                  <option value="4K">4K</option>
                </select>
              </label>
              <label className="field">
                <span>Aspect Ratio</span>
                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                  <option value="1:1">1:1</option>
                  <option value="4:3">4:3</option>
                  <option value="3:4">3:4</option>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                </select>
              </label>
            </div>
            <label className="field engine-field">
              <span>Engine Params JSON</span>
              <textarea value={engineParams} onChange={(event) => setEngineParams(event.target.value)} rows={4} />
            </label>
          </div>

          <button className="generate-button" disabled={isGenerating || !config} type="submit">
            {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            {isGenerating ? "Generating" : "Generate preview"}
          </button>

          {error && <div className="error-box">{error}</div>}

          {result && (
            <div className="surface result-surface">
              <div className="result-toolbar">
                <h2>Preview</h2>
                <a className="download-link" download="visualos-generation.png" href={imageSrc}>
                  <Download size={16} />
                  Download
                </a>
              </div>
              <img className="preview-image" src={imageSrc} alt="Generated VisualOS preview" />
              <details>
                <summary>Refined prompt</summary>
                <p>{result.refined_prompt}</p>
              </details>
              <details>
                <summary>Reference mapping</summary>
                <pre>{result.reference_mapping}</pre>
              </details>
            </div>
          )}
        </section>
      </form>
    </main>
  );
}
