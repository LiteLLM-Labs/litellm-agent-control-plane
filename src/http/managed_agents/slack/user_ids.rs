pub(super) fn normalize_slack_user_id(token: &str) -> Option<String> {
    let token = token.trim_matches(token_boundary).trim();
    let token = token
        .trim_start_matches("<@")
        .trim_start_matches('@')
        .trim_end_matches('>');
    let id = token.split('|').next().unwrap_or_default().trim();
    is_slack_user_id(id).then(|| id.to_owned())
}

fn token_boundary(ch: char) -> bool {
    matches!(
        ch,
        ',' | ';' | ':' | '.' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\''
    )
}

fn is_slack_user_id(value: &str) -> bool {
    value.len() >= 3
        && matches!(value.as_bytes().first(), Some(b'U' | b'W'))
        && value.chars().all(|ch| ch.is_ascii_alphanumeric())
}
