# Agent Evals

A personal toy project exploring agent evaluation and sandboxing.

## Vision

The long-term goal is a general-purpose tool for evaluating AI agent systems—their instructions, skills, workflows, configurations, and harnesses.

Make agent changes measurable through repeatable tasks, controlled environments, and evidence-based comparisons of behavior, outcomes, cost, and latency.

## How It Works

A case supplies an input message, an initial environment, and checks. A configured runner drives the agent; checkers assess its messages, environment changes, or other available observations. Runner and checker implementations are selected through configuration rather than evaluation-specific engine branches.

## Current Status

The project is in planning; no runnable engine is implemented yet. [M1](docs/m1-plan.md) aims to run a small filesystem-evaluation case with Pi, macOS Seatbelt, and two checkers.

The repository stays private during initial development. Reconsider publication once the initial skill-evaluation tooling is usable; visibility changes require explicit approval.

## Documentation

- [Architecture](docs/architecture.md): overall direction, responsibilities, execution boundaries, and evidence collection.
- [Cases and configuration](docs/cases.md): YAML authoring, assets, implementation selection, checks, and dataset organization.
- [M1 plan](docs/m1-plan.md): the first milestone's goal, implementation steps, acceptance, and trade-offs.

Milestone plans own their delivery details. Larger milestones may split into plans such as `m1a-plan.md` and `m1b-plan.md`, with the parent retaining the overall goal and acceptance criteria.

## License

[MIT](LICENSE)
