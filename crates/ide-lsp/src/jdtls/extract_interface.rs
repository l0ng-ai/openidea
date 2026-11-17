//! Extract Interface through jdtls' own requests: `java/checkExtractInterfaceStatus` lists the
//! members of the file's class an interface can declare and the packages it can go to,
//! `java/getRefactorEdit` (`extractInterface`) creates the interface, makes the class implement
//! it and uses it where possible. The UI picks the name, package and members and applies the edit.
use super::COMMAND_TIMEOUT;
use super::signature::{RefactorEdit, changed};
use crate::types::{ExtractInterfaceInfo, InterfaceMember, ProblemSeverity, RefactoringProblem, ServerRefactored};
use crate::{LspManager, convert};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos};
use serde::Deserialize;
use serde_json::{Value, json};

const FEATURE: &str = "Extract Interface";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    #[serde(default)]
    members: Vec<InterfaceMember>,
    #[serde(default)]
    sub_type_name: String,
    #[serde(default)]
    destination_response: Destinations,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destinations {
    #[serde(default)]
    destinations: Vec<Value>,
}

fn info_of(status: Option<Status>) -> IdeResult<ExtractInterfaceInfo> {
    let status = status
        .filter(|s| !s.sub_type_name.is_empty())
        .ok_or_else(|| IdeError::invalid("The file should declare a class"))?;
    Ok(ExtractInterfaceInfo {
        class_name: status.sub_type_name,
        members: status.members,
        packages: status.destination_response.destinations.iter().map(Value::to_string).collect(),
    })
}

impl LspManager {
    /// The class of the file at `doc`, its members and the packages for the interface.
    pub async fn extract_interface_info(
        &self,
        doc: DocId,
        pos: Pos,
        cancel: CancellationToken,
    ) -> IdeResult<ExtractInterfaceInfo> {
        let (snap, t) = self.jdtls_target(doc, FEATURE).await?;
        let params = Self::signature_context(&snap, &t, pos);
        let status: Option<Status> =
            self.call(&t, "java/checkExtractInterfaceStatus", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        info_of(status)
    }

    /// Checks extracting `members` into the interface `name` in `package` (a package from
    /// [`Self::extract_interface_info`]) and computes the edit without applying it.
    #[allow(clippy::too_many_arguments)]
    pub async fn extract_interface(
        &self,
        doc: DocId,
        pos: Pos,
        members: Vec<String>,
        name: String,
        package: Value,
        confirmation: Option<String>,
        cancel: CancellationToken,
    ) -> IdeResult<ServerRefactored> {
        let (snap, t) = self.jdtls_target(doc, FEATURE).await?;
        let mut params = json!({
            "command": "extractInterface",
            "context": Self::signature_context(&snap, &t, pos),
            "options": { "tabSize": 4, "insertSpaces": true },
            "commandArguments": [members, name, package],
        });
        if let Some(token) = confirmation {
            params["confirmationToken"] = json!(token);
        }
        let answer: Option<RefactorEdit> =
            self.call(&t, "java/getRefactorEdit", params, Some(&cancel), COMMAND_TIMEOUT).await?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        // jdtls answers nothing when its checks fail, and reports why in a message of its own.
        let Some(answer) = answer else {
            return Ok(ServerRefactored {
                problems: vec![RefactoringProblem {
                    severity: ProblemSeverity::Fatal,
                    message: "The interface could not be extracted".to_owned(),
                }],
                edit: None,
                confirmation: None,
            });
        };
        let conv = self.conv(t.enc());
        Ok(changed(answer, |e| convert::workspace_edit(&conv, e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_members_and_packages() {
        let status: Status = serde_json::from_value(json!({
            "members": [
                { "name": "area", "typeName": "double", "parameters": [], "handleIdentifier": "=p/src<a{Shape.java[Shape~area" },
                { "name": "UNIT", "typeName": "int", "handleIdentifier": "=p/src<a{Shape.java[Shape^UNIT" },
            ],
            "subTypeName": "Shape",
            "destinationResponse": { "destinations": [{ "displayName": "a", "isParentOfSelectedFile": true }] },
        }))
        .unwrap();
        let info = info_of(Some(status)).unwrap();
        assert_eq!(info.class_name, "Shape");
        assert_eq!(info.members[0].parameters.as_deref(), Some(&[][..]));
        assert_eq!(info.members[1].parameters, None);
        assert_eq!(serde_json::from_str::<Value>(&info.packages[0]).unwrap()["displayName"], "a");
        assert!(info_of(None).is_err());
    }
}
