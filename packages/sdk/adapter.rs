//! Plumb's adapter SDK for Rust: one dependency-free file that speaks the external adapter
//! protocol. Add it to a binary crate as a module; an adapter is its rules and a function from one
//! source file to findings.

use std::fmt::Write as _;
use std::io::Read as _;
use std::path::{Component, Path};
use std::process::ExitCode;

pub const PROTOCOL: u32 = 1;

const IDENTITY: &str = "Unsupported protocol, adapter identity or version.";
// deeper nesting than any request has; it bounds the parser's recursion
const DEPTH: usize = 64;

#[derive(Default)]
pub struct Rule {
    pub id: &'static str,
    pub description: &'static str,
    pub remedy: &'static str,
    pub capability: Option<&'static str>,
    pub suppressible: Option<bool>,
}

#[derive(Default)]
pub struct Finding {
    pub rule: &'static str,
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub incomplete: bool,
}

pub struct Adapter<'a> {
    pub id: &'a str,
    pub version: &'a str,
    pub files: &'a [&'a str],
    pub capabilities: &'a [&'a str],
    pub rules: &'a [Rule],
    /// the JSON Schema of the project options, as JSON text; None accepts no options
    pub options_schema: Option<&'a str>,
    /// one source with the project's validated options; Err is a source that cannot be checked
    pub check: fn(path: &str, text: &str, options: &Json) -> Result<Vec<Finding>, String>,
}

#[derive(Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// a field of an object; the last of a repeated key, as JSON.parse reads it
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(fields) => fields
                .iter()
                .rev()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, token: &str) -> bool {
        let found = self.bytes[self.at..].starts_with(token.as_bytes());
        if found {
            self.at += token.len();
        }
        found
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        self.space();
        Some(match *self.bytes.get(self.at)? {
            b'n' => self.eat("null").then_some(Json::Null)?,
            b't' => self.eat("true").then_some(Json::Bool(true))?,
            b'f' => self.eat("false").then_some(Json::Bool(false))?,
            b'"' => Json::String(self.string()?),
            b'[' if depth < DEPTH => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                while !self.eat("]") {
                    if !items.is_empty() && !self.eat(",") {
                        return None;
                    }
                    items.push(self.value(depth + 1)?);
                    self.space();
                }
                Json::Array(items)
            }
            b'{' if depth < DEPTH => {
                self.at += 1;
                let mut fields = Vec::new();
                self.space();
                while !self.eat("}") {
                    if !fields.is_empty() && !self.eat(",") {
                        return None;
                    }
                    self.space();
                    let key = self.string()?;
                    self.space();
                    if !self.eat(":") {
                        return None;
                    }
                    fields.push((key, self.value(depth + 1)?));
                    self.space();
                }
                Json::Object(fields)
            }
            _ => {
                // lenient on the number grammar: a request holds no number an answer depends on
                // beyond schemaVersion
                let start = self.at;
                while matches!(
                    self.bytes.get(self.at),
                    Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                ) {
                    self.at += 1;
                }
                Json::Number(
                    std::str::from_utf8(&self.bytes[start..self.at])
                        .ok()?
                        .parse()
                        .ok()?,
                )
            }
        })
    }

    fn string(&mut self) -> Option<String> {
        if !self.eat("\"") {
            return None;
        }
        let mut text = Vec::new();
        loop {
            let byte = *self.bytes.get(self.at)?;
            self.at += 1;
            match byte {
                b'"' => return String::from_utf8(text).ok(),
                b'\\' => {
                    let escape = *self.bytes.get(self.at)?;
                    self.at += 1;
                    match escape {
                        b'"' | b'\\' | b'/' => text.push(escape),
                        b'b' => text.push(8),
                        b'f' => text.push(12),
                        b'n' => text.push(b'\n'),
                        b'r' => text.push(b'\r'),
                        b't' => text.push(b'\t'),
                        b'u' => {
                            let mut code = self.hex()?;
                            // a surrogate pair is one character; a lone surrogate is not text
                            if (0xD800..0xDC00).contains(&code) {
                                let low = if self.eat("\\u") { self.hex()? } else { 0 };
                                if !(0xDC00..0xE000).contains(&low) {
                                    return None;
                                }
                                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                            }
                            let mut buffer = [0; 4];
                            text.extend_from_slice(
                                char::from_u32(code)?.encode_utf8(&mut buffer).as_bytes(),
                            );
                        }
                        _ => return None,
                    }
                }
                0..=0x1F => return None,
                _ => text.push(byte),
            }
        }
    }

    fn hex(&mut self) -> Option<u32> {
        let digits = self.bytes.get(self.at..self.at + 4)?;
        self.at += 4;
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
    }
}

fn parse(text: &str) -> Option<Json> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        at: 0,
    };
    let value = parser.value(0)?;
    parser.space();
    (parser.at == parser.bytes.len()).then_some(value)
}

fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            control if u32::from(control) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(control));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn list<'a>(items: impl Iterator<Item = &'a str>) -> String {
    format!("[{}]", items.map(quote).collect::<Vec<_>>().join(","))
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// the standard library has no hash a registry can pin; this is FIPS 180-4 SHA-256
fn sha256(data: &[u8]) -> String {
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&(data.len() as u64 * 8).to_be_bytes());
    for block in message.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (slot, word) in w.iter_mut().zip(block.as_chunks::<4>().0) {
            *slot = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let t2 = s0.wrapping_add((a & b) ^ (a & c) ^ (b & c));
            (h, g, f, e, d, c, b, a) = (g, f, e, d.wrapping_add(t1), c, b, a, t1.wrapping_add(t2));
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

// every adapter reports unreadable input and a malformed request under these two rules
static BUILT_IN: [Rule; 2] = [
    Rule {
        id: "input",
        description: "Every selected source has the expected bytes and remains readable.",
        remedy: "Restore the selected input and rerun the complete check.",
        capability: None,
        suppressible: Some(false),
    },
    Rule {
        id: "protocol",
        description: "Requests use the supported protocol, identity and options.",
        remedy: "Correct the adapter request or installation.",
        capability: None,
        suppressible: Some(false),
    },
];

fn rules<'a>(adapter: &'a Adapter) -> impl Iterator<Item = &'a Rule> {
    BUILT_IN.iter().chain(adapter.rules)
}

/// the registry entry for this adapter: the compiled binary, which holds this SDK, pinned by
/// content hash.
pub fn manifest(adapter: &Adapter) -> Result<String, String> {
    let binary = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| error.to_string())?;
    let hash = sha256(&std::fs::read(&binary).map_err(|error| error.to_string())?);
    let path = quote(binary.to_str().ok_or("The adapter path is not UTF-8.")?);
    let schema = adapter
        .options_schema
        .unwrap_or(r#"{"type":"object","additionalProperties":false}"#);
    parse(schema).ok_or("options_schema is not JSON.")?;
    let rules = rules(adapter)
        .map(|rule| {
            format!(
                r#"{{"id":{},"description":{},"remedy":{},"capability":{}{}}}"#,
                quote(&format!("{}/{}", adapter.id, rule.id)),
                quote(rule.description),
                quote(rule.remedy),
                quote(rule.capability.unwrap_or(adapter.capabilities[0])),
                rule.suppressible
                    .map_or(String::new(), |value| format!(r#","suppressible":{value}"#)),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        r#"{{"schemaVersion":1,"adapters":[{{"id":{},"version":{},"files":{},"capabilities":{},"command":[{path}],"integrity":[{{"path":{path},"sha256":"{hash}"}}],"environment":[],"rules":[{rules}],"optionsSchema":{schema}}}]}}"#,
        quote(adapter.id),
        quote(adapter.version),
        list(adapter.files.iter().copied()),
        list(adapter.capabilities.iter().copied()),
    ))
}

#[derive(Default)]
struct Reply {
    diagnostics: Vec<String>,
    covered: Vec<String>,
    inputs: Vec<String>,
    incomplete: bool,
}

impl Reply {
    fn add(&mut self, adapter: &Adapter, path: &str, finding: &Finding) {
        self.incomplete |= finding.incomplete;
        let mut item = format!(
            r#"{{"rule":{},"path":{},"message":{}"#,
            quote(&format!("{}/{}", adapter.id, finding.rule)),
            quote(path),
            quote(&finding.message),
        );
        if let Some(line) = finding.line {
            let _ = write!(item, r#","line":{line}"#);
        }
        if let Some(column) = finding.column {
            let _ = write!(item, r#","column":{column}"#);
        }
        if finding.incomplete {
            item.push_str(r#","status":"incomplete""#);
        }
        item.push('}');
        self.diagnostics.push(item);
    }

    fn fail(&mut self, adapter: &Adapter, rule: &'static str, path: &str, message: String) {
        self.add(
            adapter,
            path,
            &Finding {
                rule,
                message,
                incomplete: true,
                ..Finding::default()
            },
        );
    }

    fn finish(self, adapter: &Adapter) -> (u8, String) {
        let (code, status) = if self.incomplete {
            (2, "incomplete")
        } else if self.diagnostics.is_empty() {
            (0, "pass")
        } else {
            (1, "violation")
        };
        let files = self.covered.join(",");
        let coverage = adapter
            .capabilities
            .iter()
            .filter(|_| !self.covered.is_empty())
            .map(|capability| {
                format!(
                    r#"{{"capability":{},"files":[{files}]}}"#,
                    quote(capability)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let response = format!(
            r#"{{"schemaVersion":{PROTOCOL},"adapter":{},"version":{},"status":"{status}","diagnostics":[{}],"coverage":[{coverage}],"inputs":[{}]}}"#,
            quote(adapter.id),
            quote(adapter.version),
            self.diagnostics.join(","),
            self.inputs.join(","),
        );
        (code, response)
    }
}

fn relative(path: &str) -> bool {
    let parsed = Path::new(path);
    !parsed.has_root()
        && !matches!(parsed.components().next(), Some(Component::Prefix(_)))
        && !path.split(['/', '\\']).any(|part| part == "..")
}

/// answers one protocol request with the exit code and the response. Anything the adapter cannot
/// verify is incomplete, never a pass.
pub fn respond(adapter: &Adapter, request: &str) -> (u8, String) {
    let refuse = |message: &str| {
        let mut reply = Reply::default();
        reply.fail(adapter, "protocol", ".", message.to_string());
        reply.finish(adapter)
    };
    let request = parse(request);
    let field = |key: &str| request.as_ref().and_then(|value| value.get(key));
    let (Some(root), Some(files)) = (
        field("root").and_then(Json::as_str),
        field("files").and_then(Json::as_array),
    ) else {
        return refuse(IDENTITY);
    };
    if field("schemaVersion") != Some(&Json::Number(f64::from(PROTOCOL)))
        || field("adapter").and_then(Json::as_str) != Some(adapter.id)
        || field("version").and_then(Json::as_str) != Some(adapter.version)
    {
        return refuse(IDENTITY);
    }
    match field("action").and_then(Json::as_str) {
        Some("doctor") => return Reply::default().finish(adapter),
        Some("check") => {}
        _ => return refuse("Unsupported action."),
    }
    let none = Json::Object(Vec::new());
    let options = field("project")
        .and_then(|project| project.get("options"))
        .filter(|options| matches!(options, Json::Object(_)))
        .unwrap_or(&none);
    let mut reply = Reply::default();
    for file in files {
        let Some(path) = file
            .get("path")
            .and_then(Json::as_str)
            .filter(|path| relative(path))
        else {
            return refuse("A selected file is not a repository-relative path.");
        };
        let bytes = match std::fs::read(Path::new(root).join(path)) {
            Ok(bytes) => bytes,
            Err(error) => {
                reply
                    .inputs
                    .push(format!(r#"{{"path":{},"sha256":null}}"#, quote(path)));
                reply.fail(
                    adapter,
                    "input",
                    path,
                    format!("Cannot read the source: {error}"),
                );
                continue;
            }
        };
        let actual = sha256(&bytes);
        reply
            .inputs
            .push(format!(r#"{{"path":{},"sha256":"{actual}"}}"#, quote(path)));
        if file.get("sha256").and_then(Json::as_str) != Some(actual.as_str()) {
            reply.fail(
                adapter,
                "input",
                path,
                "Source hash differs from the requested input.".to_string(),
            );
            continue;
        }
        let checked = String::from_utf8(bytes)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                (adapter.check)(
                    path,
                    text.strip_prefix('\u{feff}').unwrap_or(&text),
                    options,
                )
            })
            .and_then(|findings| {
                match findings
                    .iter()
                    .find(|finding| !rules(adapter).any(|rule| rule.id == finding.rule))
                {
                    Some(stray) => Err(format!(
                        "The adapter reported the undeclared rule {}",
                        stray.rule
                    )),
                    None => Ok(findings),
                }
            });
        match checked {
            Ok(findings) => {
                for finding in &findings {
                    reply.add(adapter, path, finding);
                }
                reply.covered.push(quote(path));
            }
            Err(error) => {
                reply.fail(
                    adapter,
                    "input",
                    path,
                    format!("The source cannot be checked: {error}"),
                );
            }
        }
    }
    reply.finish(adapter)
}

/// the whole command line: --manifest prints the registry; otherwise one request on stdin gets one
/// response on stdout and the matching exit code.
pub fn serve(adapter: &Adapter) -> ExitCode {
    if std::env::args_os().any(|argument| argument == "--manifest") {
        return match manifest(adapter) {
            Ok(registry) => {
                println!("{registry}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(2)
            }
        };
    }
    let mut request = String::new();
    // an unreadable request is answered as a refused one
    if std::io::stdin().read_to_string(&mut request).is_err() {
        request.clear();
    }
    let (code, response) = respond(adapter, &request);
    println!("{response}");
    ExitCode::from(code)
}
