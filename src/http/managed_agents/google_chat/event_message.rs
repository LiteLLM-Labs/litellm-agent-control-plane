use super::types::{
    GoogleChatEvent, GoogleChatIncomingMessage, GoogleChatMessage, GoogleChatMessageMode,
};

pub(super) fn can_start_session(message: &GoogleChatIncomingMessage) -> bool {
    !matches!(message.mode, GoogleChatMessageMode::ChannelMessage)
}

pub(super) fn incoming_message_for_app(
    event: GoogleChatEvent,
    app_name: Option<&str>,
) -> Option<GoogleChatIncomingMessage> {
    if event.event_type.as_deref() != Some("MESSAGE") {
        return None;
    }
    if sender_type(&event) == Some("BOT") {
        return None;
    }
    let message = event.message.as_ref()?;
    let message_name = non_empty(message.name.as_deref())?;
    let space_name = space_name(&event, message)?;
    let thread_name = thread_name(&event, message);
    let mode = message_mode(&event, message, app_name);
    let conversation_key = conversation_key(&mode, &space_name, thread_name.as_deref());
    let prompt = clean_prompt(message.text.as_deref().unwrap_or_default());
    let user_name = event
        .user
        .as_ref()
        .and_then(|user| user.name.clone())
        .or_else(|| {
            message
                .sender
                .as_ref()
                .and_then(|sender| sender.name.clone())
        });
    Some(GoogleChatIncomingMessage {
        message_name,
        space_name,
        thread_name,
        conversation_key,
        user_name,
        prompt,
        mode,
    })
}

fn sender_type(event: &GoogleChatEvent) -> Option<&str> {
    event
        .user
        .as_ref()
        .and_then(|user| user.user_type.as_deref())
        .or_else(|| {
            event
                .message
                .as_ref()
                .and_then(|message| message.sender.as_ref())
                .and_then(|sender| sender.user_type.as_deref())
        })
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn space_name(event: &GoogleChatEvent, message: &GoogleChatMessage) -> Option<String> {
    non_empty(
        message
            .space
            .as_ref()
            .and_then(|space| space.name.as_deref())
            .or_else(|| event.space.as_ref().and_then(|space| space.name.as_deref())),
    )
}

fn thread_name(event: &GoogleChatEvent, message: &GoogleChatMessage) -> Option<String> {
    non_empty(
        message
            .thread
            .as_ref()
            .and_then(|thread| thread.name.as_deref())
            .or_else(|| {
                event
                    .thread
                    .as_ref()
                    .and_then(|thread| thread.name.as_deref())
            }),
    )
}

fn message_mode(
    event: &GoogleChatEvent,
    message: &GoogleChatMessage,
    app_name: Option<&str>,
) -> GoogleChatMessageMode {
    let space_type = message
        .space
        .as_ref()
        .and_then(|space| space.space_type.as_deref())
        .or_else(|| {
            event
                .space
                .as_ref()
                .and_then(|space| space.space_type.as_deref())
        });
    if matches!(space_type, Some("DM" | "DIRECT_MESSAGE")) {
        return GoogleChatMessageMode::DirectMessage;
    }
    if has_app_mention(message, app_name) {
        return GoogleChatMessageMode::ChannelMention;
    }
    GoogleChatMessageMode::ChannelMessage
}

fn has_app_mention(message: &GoogleChatMessage, app_name: Option<&str>) -> bool {
    message
        .annotations
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|annotation| mention_targets_app(annotation, app_name))
}

fn mention_targets_app(
    annotation: &super::types::GoogleChatAnnotation,
    app_name: Option<&str>,
) -> bool {
    if annotation.annotation_type.as_deref() != Some("USER_MENTION") {
        return false;
    }
    let Some(user) = annotation
        .user_mention
        .as_ref()
        .and_then(|mention| mention.user.as_ref())
    else {
        return false;
    };
    if user.user_type.as_deref() != Some("BOT") {
        return false;
    }
    match app_name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(expected) => user.display_name.as_deref() == Some(expected),
        None => true,
    }
}

fn conversation_key(
    mode: &GoogleChatMessageMode,
    space_name: &str,
    thread_name: Option<&str>,
) -> String {
    match mode {
        GoogleChatMessageMode::DirectMessage => space_name.to_owned(),
        GoogleChatMessageMode::ChannelMention | GoogleChatMessageMode::ChannelMessage => {
            thread_name.unwrap_or(space_name).to_owned()
        }
    }
}

fn clean_prompt(text: &str) -> String {
    let prompt = text
        .split_whitespace()
        .filter(|part| !part.starts_with("<at>") && !part.ends_with("</at>"))
        .collect::<Vec<_>>()
        .join(" ");
    match prompt.trim() {
        "" => "Proceed with your task.".to_owned(),
        value => value.to_owned(),
    }
}
