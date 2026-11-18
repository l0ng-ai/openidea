//! Codex's asynchronous questions are answered by a user message, not a permission response.

use crate::AgentQuestion;
use ide_core::{IdeError, IdeResult};
use serde_json::json;
use std::collections::BTreeMap;

/// The wire reply and its readable record. Question ids, not wording, associate each answer.
pub(crate) fn reply(questions: &[AgentQuestion], answers: &str) -> IdeResult<(String, String)> {
    let answers: BTreeMap<String, Vec<String>> =
        serde_json::from_str(answers).map_err(|_| IdeError::invalid("invalid question answers"))?;
    if questions.is_empty() || answers.len() != questions.len() {
        return Err(IdeError::invalid("answer every question"));
    }
    let mut replies = Vec::new();
    let mut record = Vec::new();
    for question in questions {
        let key = question.answer_key.as_deref().ok_or_else(|| IdeError::invalid("missing question id"))?;
        let values = answers.get(key).ok_or_else(|| IdeError::invalid("missing question answer"))?;
        if values.is_empty()
            || (!question.multi_select && values.len() != 1)
            || values.iter().any(|v| v.trim().is_empty())
        {
            return Err(IdeError::invalid("empty or invalid question answer"));
        }
        let answer = values.iter().map(|v| v.trim()).collect::<Vec<_>>().join(", ");
        let mut title = question.question.clone();
        let mut end = title.len().min(512);
        while !title.is_char_boundary(end) {
            end -= 1;
        }
        title.truncate(end);
        title = title.replace(['\n', '\r'], " ");
        replies.push(json!({ "questionItemId": key, "question": title, "answer": answer }));
        record.push(format!("{}: {}", question.question, answer));
    }
    Ok((
        format!("<send_user_message_question_reply>\n{}\n</send_user_message_question_reply>", json!(replies)),
        record.join("\n"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(key: &str) -> AgentQuestion {
        AgentQuestion {
            answer_key: Some(key.into()),
            header: String::new(),
            question: "Which?".into(),
            multi_select: false,
            options: Vec::new(),
        }
    }

    #[test]
    fn identical_wording_keeps_answers_associated_with_ids() {
        let (wire, record) =
            reply(&[question("first"), question("second")], r#"{"first":[" One "],"second":["Two"]}"#).unwrap();
        let body = wire
            .strip_prefix("<send_user_message_question_reply>\n")
            .unwrap()
            .strip_suffix("\n</send_user_message_question_reply>")
            .unwrap();
        let replies: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(replies[0], json!({"questionItemId":"first","question":"Which?","answer":"One"}));
        assert_eq!(replies[1]["answer"], "Two");
        assert_eq!(record, "Which?: One\nWhich?: Two");
    }

    #[test]
    fn malformed_missing_and_empty_answers_are_rejected() {
        for answers in
            ["no", "{}", r#"{"other":["One"]}"#, r#"{"first":[]}"#, r#"{"first":[" "]}"#, r#"{"first":["One","Two"]}"#]
        {
            assert!(reply(&[question("first")], answers).is_err(), "{answers}");
        }
    }
}
