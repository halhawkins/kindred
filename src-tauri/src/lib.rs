use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const OLLAMA_URL: &str = "http://127.0.0.1:11434";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdeaContextNode {
    text: String,
    note: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdeaSuggestionContext {
    selected: IdeaContextNode,
    parent: Option<IdeaContextNode>,
    children: Vec<IdeaContextNode>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct OllamaTags {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaChatMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaChatMessage,
}

#[derive(Debug, Deserialize)]
struct GeneratedSuggestions {
    suggestions: Vec<String>,
}

#[derive(Clone, Copy)]
enum CloudAiProvider {
    OpenAi,
    Gemini,
    Anthropic,
}

impl CloudAiProvider {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "gemini" => Ok(Self::Gemini),
            "anthropic" => Ok(Self::Anthropic),
            _ => Err("Choose a supported online AI provider.".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
            Self::Anthropic => "anthropic",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Gemini => "Google Gemini",
            Self::Anthropic => "Anthropic",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MindMapNode {
    id: String,
    parent_id: Option<String>,
    text: String,
    note: String,
    color: String,
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize, Serialize)]
struct MindMapDocument {
    version: u8,
    title: String,
    nodes: Vec<MindMapNode>,
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default)]
    images: Vec<MindMapImage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MindMapImage {
    id: String,
    #[serde(default)]
    parent_id: Option<String>,
    name: String,
    data_url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn default_theme() -> String {
    "paper".into()
}

fn document_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    Ok(app_data_dir.join("mind-map.json"))
}

fn validate_document(document: &MindMapDocument) -> Result<(), String> {
    if document.version != 1 {
        return Err("Unsupported mind map version.".into());
    }
    if document.title.len() > 320 {
        return Err("The map title is too long.".into());
    }
    if !matches!(
        document.theme.as_str(),
        "paper" | "meadow" | "ocean" | "lavender" | "night"
    ) {
        return Err("Unsupported board theme.".into());
    }
    if document.nodes.is_empty() || document.nodes.len() > 1000 {
        return Err("A mind map must contain between 1 and 1000 ideas.".into());
    }
    if document.images.len() > 10 {
        return Err("A mind map can contain at most 10 images.".into());
    }

    let mut ids = HashSet::with_capacity(document.nodes.len() + document.images.len());
    let mut children = HashMap::<&str, Vec<&str>>::new();
    for node in &document.nodes {
        if node.id.is_empty() || !ids.insert(node.id.as_str()) {
            return Err("Mind map idea IDs must be unique and non-empty.".into());
        }
        if node.text.len() > 640 || node.note.len() > 2000 {
            return Err("An idea or note exceeds its allowed length.".into());
        }
        if !node.x.is_finite() || !node.y.is_finite() {
            return Err("Mind map coordinates must be finite numbers.".into());
        }
        if let Some(parent_id) = node.parent_id.as_deref() {
            children.entry(parent_id).or_default().push(&node.id);
        }
    }

    let roots: Vec<_> = document
        .nodes
        .iter()
        .filter(|node| node.parent_id.is_none())
        .collect();
    if roots.len() != 1 {
        return Err("A mind map must have exactly one root idea.".into());
    }
    let mut total_image_data = 0;
    for image in &document.images {
        if image.id.is_empty() || !ids.insert(image.id.as_str()) {
            return Err("Mind map entity IDs must be unique and non-empty.".into());
        }
        if image.name.len() > 480
            || image.width <= 0.0
            || image.width > 400.0
            || image.height <= 0.0
            || image.height > 400.0
            || !image.x.is_finite()
            || !image.y.is_finite()
            || !image.width.is_finite()
            || !image.height.is_finite()
        {
            return Err("A mind map image has invalid dimensions or position.".into());
        }
        let parent_id = image
            .parent_id
            .as_deref()
            .ok_or("Every image must connect to a parent idea.")?;
        children.entry(parent_id).or_default().push(&image.id);
        let Some((mime, payload)) = image.data_url.split_once(',') else {
            return Err("A mind map image has invalid image data.".into());
        };
        if !matches!(
            mime,
            "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
        ) || payload.is_empty()
            || !payload.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
            })
        {
            return Err("A mind map image has invalid image data.".into());
        }
        total_image_data += image.data_url.len();
    }
    if document.nodes.iter().any(|node| {
        node.parent_id
            .as_ref()
            .is_some_and(|parent_id| !ids.contains(parent_id.as_str()))
    }) || document.images.iter().any(|image| {
        image
            .parent_id
            .as_ref()
            .is_some_and(|parent_id| !ids.contains(parent_id.as_str()))
    }) {
        return Err("Every map item must connect to an existing parent.".into());
    }

    let mut reachable = HashSet::with_capacity(ids.len());
    let mut pending = vec![roots[0].id.as_str()];
    while let Some(id) = pending.pop() {
        if !reachable.insert(id) {
            continue;
        }
        if let Some(descendants) = children.get(id) {
            pending.extend(descendants.iter().copied());
        }
    }
    if reachable.len() != ids.len() {
        return Err("Every map item must be connected to the root idea.".into());
    }
    if total_image_data > 2_000_000 {
        return Err("The combined images are too large for a local mind map.".into());
    }

    Ok(())
}

#[tauri::command]
fn load_map(app: AppHandle) -> Result<Option<MindMapDocument>, String> {
    let path = document_path(&app)?;
    match fs::read_to_string(path) {
        Ok(contents) => {
            let mut document: MindMapDocument =
                serde_json::from_str(&contents).map_err(|error| error.to_string())?;
            if let Some(root_id) = document
                .nodes
                .iter()
                .find(|node| node.parent_id.is_none())
                .map(|node| node.id.clone())
            {
                for image in &mut document.images {
                    if image.parent_id.is_none() {
                        image.parent_id = Some(root_id.clone());
                    }
                }
            }
            validate_document(&document)?;
            Ok(Some(document))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_map(app: AppHandle, document: MindMapDocument) -> Result<(), String> {
    validate_document(&document)?;
    let path = document_path(&app)?;
    let contents = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn validate_model_tag(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 100
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
    {
        return Err("Enter a valid Ollama model tag, such as qwen2.5:3b.".into());
    }
    Ok(())
}

fn cloud_ai_key_entry(provider: CloudAiProvider) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.kindred.mindmap.cloud-ai", provider.as_str()).map_err(|error| {
        format!("Couldn't access the operating system's credential manager: {error}")
    })
}

#[tauri::command]
fn cloud_ai_key_saved(provider: String) -> Result<bool, String> {
    let provider = CloudAiProvider::parse(&provider)?;
    let entry = cloud_ai_key_entry(provider)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("Couldn't read the saved API key: {error}")),
    }
}

#[tauri::command]
fn save_cloud_ai_key(provider: String, api_key: String) -> Result<(), String> {
    let provider = CloudAiProvider::parse(&provider)?;
    if api_key.is_empty()
        || api_key.len() > 512
        || api_key.trim() != api_key
        || !api_key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err("Enter a valid API key without spaces or line breaks.".into());
    }
    cloud_ai_key_entry(provider)?
        .set_password(&api_key)
        .map_err(|error| {
            format!(
                "Couldn't save the API key in the operating system's credential manager: {error}"
            )
        })
}

#[tauri::command]
fn remove_cloud_ai_key(provider: String) -> Result<(), String> {
    let provider = CloudAiProvider::parse(&provider)?;
    match cloud_ai_key_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Couldn't remove the saved API key: {error}")),
    }
}

fn validate_cloud_model(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 120
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("Enter a valid model ID for the selected provider.".into());
    }
    Ok(())
}

fn ollama_error(error: reqwest::Error) -> String {
    format!(
        "Couldn't connect to Ollama at {OLLAMA_URL}. Install Ollama from https://ollama.com/download, start it, and try again. ({error})"
    )
}

async fn fetch_ollama_models(client: &reqwest::Client) -> Result<Vec<String>, String> {
    let response = client
        .get(format!("{OLLAMA_URL}/api/tags"))
        .send()
        .await
        .map_err(ollama_error)?
        .error_for_status()
        .map_err(|error| format!("Ollama couldn't list its models: {error}"))?;
    let tags: OllamaTags = response
        .json()
        .await
        .map_err(|error| format!("Ollama returned an invalid model list: {error}"))?;
    Ok(tags.models.into_iter().map(|model| model.name).collect())
}

fn ollama_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Couldn't configure the Ollama connection: {error}"))
}

#[tauri::command]
async fn ollama_models() -> Result<Vec<String>, String> {
    let client = ollama_client(Duration::from_secs(10))?;
    fetch_ollama_models(&client).await
}

#[tauri::command]
async fn download_ollama_model(model: String) -> Result<(), String> {
    validate_model_tag(&model)?;
    let client = ollama_client(Duration::from_secs(1800))?;
    if fetch_ollama_models(&client)
        .await?
        .iter()
        .any(|name| name == &model)
    {
        return Ok(());
    }

    let response = client
        .post(format!("{OLLAMA_URL}/api/pull"))
        .json(&json!({ "name": model, "stream": false }))
        .send()
        .await
        .map_err(ollama_error)?
        .error_for_status()
        .map_err(|error| format!("Ollama couldn't download {model}: {error}"))?;
    let _: Value = response
        .json()
        .await
        .map_err(|error| format!("Ollama returned an invalid model download response: {error}"))?;
    Ok(())
}

fn exceeds_utf16_length(value: &str, limit: usize) -> bool {
    value.encode_utf16().count() > limit
}

fn parse_suggestions(response: &str) -> Result<Vec<String>, String> {
    if response.trim().is_empty() {
        return Err(
            "The AI provider returned an empty answer. Try again, or check that the configured model supports chat responses."
                .into(),
        );
    }
    let generated: GeneratedSuggestions = serde_json::from_str(response).map_err(|error| {
        format!("The AI provider returned suggestions in an unexpected format: {error}")
    })?;
    let mut suggestions = Vec::new();
    for suggestion in generated.suggestions {
        let suggestion = suggestion.trim();
        let word_count = suggestion.split_whitespace().count();
        if suggestion.is_empty()
            || word_count < 6
            || word_count > 14
            || exceeds_utf16_length(suggestion, 140)
        {
            continue;
        }
        if !suggestions
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(suggestion))
        {
            suggestions.push(suggestion.to_owned());
        }
        if suggestions.len() == 10 {
            break;
        }
    }
    if suggestions.len() < 3 {
        return Err(
            "The AI provider returned fewer than 3 concise idea suggestions. Try again.".into(),
        );
    }
    Ok(suggestions)
}

fn validate_suggestion_context(context: &IdeaSuggestionContext) -> Result<(), String> {
    if context.children.len() > 1000
        || exceeds_utf16_length(&context.selected.text, 160)
        || exceeds_utf16_length(&context.selected.note, 500)
        || context.parent.as_ref().is_some_and(|parent| {
            exceeds_utf16_length(&parent.text, 160) || exceeds_utf16_length(&parent.note, 500)
        })
        || context.children.iter().any(|child| {
            exceeds_utf16_length(&child.text, 160) || exceeds_utf16_length(&child.note, 500)
        })
    {
        return Err("The selected idea contains invalid suggestion context.".into());
    }
    Ok(())
}

fn suggestion_prompt(context: &IdeaSuggestionContext) -> String {
    let parent = context
        .parent
        .as_ref()
        .map(|node| format!("{}\nNote: {}", node.text, node.note))
        .unwrap_or_else(|| "None".to_owned());
    let children = if context.children.is_empty() {
        "None".to_owned()
    } else {
        context
            .children
            .iter()
            .map(|node| format!("- {} (note: {})", node.text, node.note))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Generate 3 to 10 useful, distinct ideas that logically extend this mind-map branch. Write each suggestion as one complete, relevant sentence, aiming for 8 to 12 words. Keep the language clear and concise; don't add explanations, numbering, or repeat existing child ideas. Return only a JSON object with exactly this shape: {{\"suggestions\":[\"sentence 1\",\"sentence 2\"]}}. Selected idea:\n{}\nNote: {}\nParent idea:\n{}\nExisting children:\n{}",
        context.selected.text, context.selected.note, parent, children
    )
}

fn cloud_response_text(provider: CloudAiProvider, response: &Value) -> Result<&str, String> {
    let path = match provider {
        CloudAiProvider::OpenAi => "/choices/0/message/content",
        CloudAiProvider::Gemini => "/candidates/0/content/parts/0/text",
        CloudAiProvider::Anthropic => "/content/0/text",
    };
    response
        .pointer(path)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} returned an unexpected response.", provider.label()))
}

fn cloud_http_error(
    provider: CloudAiProvider,
    status: reqwest::StatusCode,
    body: &str,
    api_key: &str,
) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/error").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.to_owned());
    let detail = detail.replace(api_key, "[redacted]");
    let detail: String = detail.chars().take(400).collect();
    format!("{} returned HTTP {status}: {detail}", provider.label())
}

async fn request_cloud_suggestions(
    provider: CloudAiProvider,
    model: &str,
    api_key: &str,
    prompt: &str,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| format!("Couldn't configure the {} connection.", provider.label()))?;

    let request = match provider {
        CloudAiProvider::OpenAi => client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "messages": [{ "role": "user", "content": prompt }],
                "response_format": { "type": "json_object" },
                "max_completion_tokens": 512
            })),
        CloudAiProvider::Gemini => client
            .post(format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            ))
            .header("x-goog-api-key", api_key)
            .json(&json!({
                "contents": [{ "parts": [{ "text": prompt }] }],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "maxOutputTokens": 512
                }
            })),
        CloudAiProvider::Anthropic => client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": 512,
                "messages": [{ "role": "user", "content": prompt }]
            })),
    };
    let response = request.send().await.map_err(|_| {
        format!(
            "Couldn't connect to {}. Check your internet connection and try again.",
            provider.label()
        )
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| format!("{} returned an unreadable response.", provider.label()))?;
    if !status.is_success() {
        return Err(cloud_http_error(provider, status, &body, api_key));
    }
    let response: Value = serde_json::from_str(&body)
        .map_err(|_| format!("{} returned an invalid response.", provider.label()))?;
    parse_suggestions(cloud_response_text(provider, &response)?)
}

#[tauri::command]
async fn suggest_cloud_ideas(
    context: IdeaSuggestionContext,
    provider: String,
    model: String,
) -> Result<Vec<String>, String> {
    let provider = CloudAiProvider::parse(&provider)?;
    validate_cloud_model(&model)?;
    validate_suggestion_context(&context)?;
    let entry = cloud_ai_key_entry(provider)?;
    let api_key = match entry.get_password() {
        Ok(api_key) => api_key,
        Err(keyring::Error::NoEntry) => {
            return Err(format!(
                "No API key is saved for {}. Add one in AI settings.",
                provider.label()
            ))
        }
        Err(error) => return Err(format!("Couldn't read the saved API key: {error}")),
    };
    request_cloud_suggestions(provider, &model, &api_key, &suggestion_prompt(&context)).await
}

#[tauri::command]
async fn suggest_ideas(
    context: IdeaSuggestionContext,
    model: String,
) -> Result<Vec<String>, String> {
    validate_model_tag(&model)?;
    validate_suggestion_context(&context)?;

    let client = ollama_client(Duration::from_secs(1800))?;
    if !fetch_ollama_models(&client)
        .await?
        .iter()
        .any(|available| available == &model)
    {
        return Err(format!(
            "The Ollama model {model} is not available. Open AI settings to download it."
        ));
    }

    let prompt = suggestion_prompt(&context);
    let response = client
        .post(format!("{OLLAMA_URL}/api/chat"))
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "format": "json",
            "stream": false,
            "think": false,
            "options": { "num_predict": 512 }
        }))
        .send()
        .await
        .map_err(ollama_error)?
        .error_for_status()
        .map_err(|error| format!("Ollama couldn't generate suggestions: {error}"))?;
    let chat: OllamaChatResponse = response
        .json()
        .await
        .map_err(|error| format!("Ollama returned an invalid chat response: {error}"))?;
    parse_suggestions(&chat.message.content)
}

#[cfg(test)]
mod tests {
    use super::parse_suggestions;

    #[test]
    fn suggestions_are_unique_and_limited_to_ten_short_titles() {
        let response = serde_json::json!({
            "suggestions": [
                "First idea should help you begin today",
                "Second idea could make this plan easier",
                "Third idea might add a little balance",
                "FIRST IDEA SHOULD HELP YOU BEGIN TODAY",
                "A title that contains fifteen distinct words and cannot be considered concise for a node",
                "Fourth idea should give this plan more focus",
                "Fifth idea may make the next step easier",
                "Sixth idea could help everyone feel included",
                "Seventh idea would create a better rhythm",
                "Eighth idea might offer a useful perspective",
                "Ninth idea can help keep things simple",
                "Tenth idea should make this experience more enjoyable",
                "Eleventh idea can help this plan feel complete"
            ]
        });
        let suggestions = parse_suggestions(&response.to_string()).unwrap();

        assert_eq!(suggestions.len(), 10);
        assert_eq!(
            suggestions
                .iter()
                .filter(|suggestion| suggestion
                    .eq_ignore_ascii_case("First idea should help you begin today"))
                .count(),
            1
        );
    }

    #[test]
    fn suggestions_require_at_least_three_short_titles() {
        let response =
            serde_json::json!({ "suggestions": ["One", "Too many words in this title"] });

        assert!(parse_suggestions(&response.to_string()).is_err());
    }

    #[test]
    fn empty_model_responses_have_a_useful_error() {
        let error = parse_suggestions("").unwrap_err();

        assert!(error.contains("empty answer"));
    }

    #[test]
    fn online_providers_extract_suggestion_text_from_their_response_shapes() {
        assert_eq!(
            super::cloud_response_text(
                super::CloudAiProvider::OpenAi,
                &serde_json::json!({ "choices": [{ "message": { "content": "openai" } }] })
            )
            .unwrap(),
            "openai"
        );
        assert_eq!(
            super::cloud_response_text(
                super::CloudAiProvider::Gemini,
                &serde_json::json!({ "candidates": [{ "content": { "parts": [{ "text": "gemini" }] } }] })
            )
            .unwrap(),
            "gemini"
        );
        assert_eq!(
            super::cloud_response_text(
                super::CloudAiProvider::Anthropic,
                &serde_json::json!({ "content": [{ "type": "text", "text": "anthropic" }] })
            )
            .unwrap(),
            "anthropic"
        );
    }

    #[test]
    fn cloud_provider_error_messages_redact_api_keys() {
        let error = super::cloud_http_error(
            super::CloudAiProvider::OpenAi,
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"Rejected key sk-secret"}}"#,
            "sk-secret",
        );

        assert!(error.contains("[redacted]"));
        assert!(!error.contains("sk-secret"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_map,
            save_map,
            ollama_models,
            download_ollama_model,
            suggest_ideas,
            cloud_ai_key_saved,
            save_cloud_ai_key,
            remove_cloud_ai_key,
            suggest_cloud_ideas
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kindred");
}
