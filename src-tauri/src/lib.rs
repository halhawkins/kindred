use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};
use tauri::{AppHandle, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_map, save_map])
        .run(tauri::generate_context!())
        .expect("error while running Kindred");
}
