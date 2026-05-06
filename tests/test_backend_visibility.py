from backend.material_visibility import is_student_visible_ready_material


def test_fastapi_retrieval_excludes_hidden_or_teacher_only_materials() -> None:
    hidden_materials = [
        {"status": "ready", "activeForStudents": False},
        {"status": "ready", "studentVisible": False},
        {"status": "ready", "teacherOnly": True},
        {"status": "ready", "visibility": "teacher-only"},
        {"status": "ready", "visibility": "hidden"},
        {"status": "ready", "private": True},
        {"status": "processing"},
    ]

    for material in hidden_materials:
        assert is_student_visible_ready_material(material) is False


def test_fastapi_retrieval_keeps_ready_student_visible_materials() -> None:
    assert is_student_visible_ready_material({"status": "ready"}) is True
    assert is_student_visible_ready_material({"status": "ready", "studentVisible": True}) is True
