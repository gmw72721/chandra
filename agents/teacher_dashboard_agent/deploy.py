import os

import vertexai


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required to deploy the teacher dashboard agent.")
    return value


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    project = required_env("GOOGLE_CLOUD_PROJECT")
    location = os.getenv("GEMINI_AGENT_LOCATION", os.getenv("GOOGLE_CLOUD_LOCATION", "global"))
    client = vertexai.Client(project=project, location=location)

    remote_agent = client.agent_engines.create(
        config={
            "display_name": "ADK Teacher Dashboard Agent",
            "description": "Chandra teacher dashboard assistant deployed from Dockerfile.",
            "source_packages": [
                "agent.py",
                "main.py",
                "requirements.txt",
                "Dockerfile",
            ],
            "image_spec": {},
            "agent_framework": "google-adk",
            "env_vars": {
                "CHANDRA_ASSISTANT_TOOL_BASE_URL": required_env("CHANDRA_ASSISTANT_TOOL_BASE_URL"),
                "CHANDRA_ASSISTANT_TOOL_SHARED_SECRET": required_env("CHANDRA_ASSISTANT_TOOL_SHARED_SECRET"),
                "GOOGLE_CLOUD_LOCATION": os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
                "GOOGLE_CLOUD_PROJECT": project,
                "GOOGLE_GENAI_USE_VERTEXAI": "True",
                "TEACHER_ASSISTANT_MODEL": os.getenv("TEACHER_ASSISTANT_MODEL", "gemini-3-flash-preview"),
            },
            # Other optional configs:
            # "service_account": "agent-runtime@PROJECT_ID.iam.gserviceaccount.com",
            # "min_instances": 0,
            # "max_instances": 3,
            # "container_concurrency": 10,
            # "resource_limits": {"cpu": "1", "memory": "2Gi"},
        }
    )

    resource_name = getattr(remote_agent, "resource_name", None) or remote_agent.api_resource.name
    print(resource_name)
    print("Set GEMINI_AGENT_RUNTIME_RESOURCE to this resource name in Chandra:")
    print(resource_name)


if __name__ == "__main__":
    main()
