from __future__ import annotations

from typing import Any


def is_student_visible_ready_material(material: dict[str, Any]) -> bool:
    return (
        material.get("status") == "ready"
        and material.get("activeForStudents") is not False
        and material.get("studentVisible") is not False
        and material.get("teacherOnly") is not True
        and material.get("visibility") not in {"teacher-only", "hidden"}
        and material.get("private") is not True
    )
