use serde_json::Value;

pub(super) fn event_payload(line: &str) -> Option<(String, Value)> {
    let data = line.strip_prefix("data: ")?;
    let payload: Value = serde_json::from_str(data.trim()).ok()?;
    Some((
        payload.get("type")?.as_str()?.to_owned(),
        payload.get("properties")?.clone(),
    ))
}

pub(super) fn text_len(text: &str) -> usize {
    text.chars().count()
}

pub(super) fn split_at_char_limit(text: &str, limit: usize) -> (&str, usize) {
    if text_len(text) <= limit {
        return (text, text.len());
    }
    let mut split = text.len();
    for (count, (index, _)) in text.char_indices().enumerate() {
        if count == limit {
            split = index;
            break;
        }
    }
    (&text[..split], split)
}

#[cfg(test)]
mod tests {
    use super::{split_at_char_limit, text_len};

    #[test]
    fn split_at_char_limit_keeps_utf8_boundary() {
        let text = "abc🙂def";
        let (head, offset) = split_at_char_limit(text, 4);

        assert_eq!(head, "abc🙂");
        assert_eq!(&text[offset..], "def");
    }

    #[test]
    fn split_at_char_limit_returns_full_text_when_short() {
        let text = "short";
        let (head, offset) = split_at_char_limit(text, 10);

        assert_eq!(head, text);
        assert_eq!(offset, text.len());
        assert_eq!(text_len(head), 5);
    }
}
