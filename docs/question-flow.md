# War Research — Question Processing Flow Graph

## How a user question flows through the system

Each box is a step in the pipeline; arrows show the order actions happen in. Amber boxes are LLM calls (with their model tier), blue is the one external tool call, grey diamonds are routing/decision points with no LLM involved.

```mermaid
flowchart TD
    Q_START(["user question"]) --> CLAR["clarification_node<br/>① fullModel"]
    CLAR -- "not war-related" --> END_REJECT(["END — reply with reject reason"])
    CLAR -- "too vague" --> END_CLARIFY(["END — ask clarifying question"])
    CLAR -- "clear & valid" --> BRIEF["briefing_node<br/>② miniModel"]
    BRIEF --> SASSESS

    subgraph SUP[" Supervisor Agent "]
        direction TB
        SASSESS["supervisor_node: assess<br/>③ fullModel"] --> SDISPATCH["supervisor_node: dispatch<br/>④ nanoModel (tool_choice: required)"]
        SDISPATCH --> SROUTE{{"supervisor_tool_node"}}
        SROUTE -- "CompleteResearch\nor turn limit" --> SUP_DONE(["supervisor done"])
    end

    SROUTE -- "ConductResearch ×N\n(parallel)" --> RASSESS

    subgraph RES[" Research Agent — one instance per topic, run in parallel "]
        direction TB
        RASSESS["research_node: assess<br/>⑤ fullModel"] --> RDISPATCH["research_node: dispatch<br/>⑥ nanoModel (tool_choice: required)"]
        RDISPATCH --> RROUTE{{"research_tool_node"}}
        RROUTE -- "TavilySearch ×N\n(parallel)" --> TAVILY["Tavily Search API"]
        TAVILY --> SUMM["summarizeWebpage ×results\n(parallel)<br/>⑦ miniModel"]
        SUMM -. "loop: results appended,\nreassess" .-> RASSESS
        RROUTE -- "CompleteSearch" --> COMPRESS["compression_node<br/>⑧ fullModel"]
    end

    COMPRESS -. "loop: compressed notes appended,\nsupervisor reassesses" .-> SASSESS

    SUP_DONE --> REPORT["report_generator<br/>⑨ fullModel"]
    REPORT --> END_FINAL(["END — final report returned"])

    classDef llm fill:#FDEBD0,stroke:#B9770E,color:#7E5109,stroke-width:1.5px;
    classDef tool fill:#D6EAF8,stroke:#2874A6,color:#1B4F72,stroke-width:1.5px;
    classDef route fill:#F4F6F7,stroke:#909497,color:#212F3D,stroke-width:1.5px;
    classDef term fill:#EAECEE,stroke:#616A6B,color:#17202A,stroke-width:1px;

    class CLAR,BRIEF,SASSESS,SDISPATCH,RASSESS,RDISPATCH,SUMM,COMPRESS,REPORT llm;
    class TAVILY tool;
    class SROUTE,RROUTE route;
    class Q_START,END_REJECT,END_CLARIFY,END_FINAL,SUP_DONE term;
```

**Reading the loops:** the Supervisor Agent keeps assessing → dispatching → routing until it calls `CompleteResearch` (or hits its turn limit); each `ConductResearch` call spins up a parallel Research Agent instance, which itself loops assess → dispatch → search → summarize until it calls `CompleteSearch`, then compresses its findings and hands them back to the supervisor for the next reassessment round.
