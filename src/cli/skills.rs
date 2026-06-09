use std::{
    fs,
    path::{Path, PathBuf},
};

const SKILL_DIR: &str = ".claude/skills/lite-schedule";
const SKILL_FILE: &str = "SKILL.md";
const LITE_SCHEDULE_SKILL: &str = include_str!("../../skills/lite-schedule.md");

pub(crate) fn ensure_lite_schedule_skill(
    root: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_path = root.join(SKILL_DIR).join(SKILL_FILE);
    if skill_path.exists() {
        return Ok(skill_path);
    }

    if let Some(parent) = skill_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&skill_path, LITE_SCHEDULE_SKILL)?;
    Ok(skill_path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::ensure_lite_schedule_skill;

    #[test]
    fn writes_lite_schedule_skill_when_missing() {
        let temp_dir = TempDir::new().unwrap();

        let skill_path = ensure_lite_schedule_skill(temp_dir.path()).unwrap();

        let skill = fs::read_to_string(skill_path).unwrap();
        assert!(skill.contains("name: lite-schedule"));
        assert!(skill.contains("What should the agent do?"));
        assert!(skill.contains("Default to the repository"));
    }

    #[test]
    fn leaves_existing_lite_schedule_skill_unchanged() {
        let temp_dir = TempDir::new().unwrap();
        let skill_path = temp_dir
            .path()
            .join(".claude")
            .join("skills")
            .join("lite-schedule")
            .join("SKILL.md");
        fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        fs::write(&skill_path, "custom").unwrap();

        ensure_lite_schedule_skill(temp_dir.path()).unwrap();

        assert_eq!(fs::read_to_string(skill_path).unwrap(), "custom");
    }
}
