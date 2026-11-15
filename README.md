RapidAid – AI-Assisted Emergency Response & Ambulance Coordination System
Smarter coordination. Faster emergency response.

RapidAid is a web-based emergency response coordination prototype designed to bring emergency reporting, AI-assisted information processing, ambulance recommendation, dispatcher-controlled assignment, response tracking, route support, and hospital coordination into one connected workflow.

Project type: Academic prototype
Team: Shivam Yadav and Yash Kumar
Repository: https://github.com/shivam123yadav/RapidAid
Frontend: https://rapidaid-web.onrender.com
Backend: https://rapidaid-api-vpms.onrender.com
📌 Table of Contents
- Overview
- Problem Statement
- Objectives
- Key Features
- How RapidAid Works
- Emergency Lifecycle
- User Roles
- System Architecture
- Technology Stack
- AI and Intelligent Processing
- Ambulance Recommendation
- Map and Routing
- Hospital Coordination
- Authentication and RBAC
- Demo Scenario
- Project Structure
- Local Development
- Environment Configuration
- Testing and Validation
- Deployment
- Limitations
- Future Scope
- Safety and Disclaimer
- Team
- Project Links
🚑 Overview
Emergency response often involves multiple steps:

Report → Understand → Recommend → Assign → Respond → Coordinate → Complete

If these steps are handled through disconnected systems or incomplete information, coordination can become difficult.

RapidAid provides a unified software workflow where:
1. A citizen reports an emergency using text or voice.
2. Voice input can be converted into text using Whisper-base.
3. AI-assisted processing helps structure important incident information.
4. The system recommends potentially suitable ambulances.
5. An authorized dispatcher reviews the information and recommendation.
6. The dispatcher confirms or changes the assignment.
7. The emergency progresses through defined response statuses.
8. Route and hospital coordination support the response.
9. The incident is completed and the ambulance becomes available again.
RapidAid is an academic prototype and is not intended to replace official emergency services.
❗ Problem Statement
Emergency response coordination can face several challenges:
- Emergency reports may be incomplete or unstructured.
- Reports may arrive through voice and different languages.
- Important information may need to be extracted quickly.
- Selecting an ambulance manually can be difficult when several resources are available.
- Responders may have limited visibility into the current emergency status.
- Hospital coordination can be separated from the ambulance workflow.
- Different response activities may not be represented in one consistent lifecycle.
RapidAid addresses these problems through a connected digital workflow and AI-assisted decision support.
🎯 Objectives
The main objectives of RapidAid are:
- Provide an easy emergency reporting interface.
- Support voice-based emergency reporting.
- Convert speech into editable text.
- Assist with extracting structured incident information.
- Recommend suitable ambulances using operational information.
- Keep the dispatcher in control of final resource assignment.
- Track emergency progress through defined states.
- Provide route support through OSRM.
- Support hospital coordination.
- Maintain role-based access to system functions.
- Store emergency and operational data in a centralized database.
✨ Key Features
1. Voice-Assisted Emergency Reporting
RapidAid allows emergency information to be entered through voice or text.

For voice input, the application uses:
- Transformers.js
- Whisper-base
- ONNX Runtime Web
The speech-processing workflow runs in the browser.

The resulting transcript can be reviewed and edited before continuing with the emergency workflow.
Important: Whisper is used for speech-to-text. It does not itself decide the emergency type, assign an ambulance, or perform the complete emergency analysis.

2. AI-Assisted Information Extraction
After transcription, a separate AI-assisted processing component helps structure the reported information.

Depending on the available report, the system can organize information such as:
- Incident type
- Severity
- Location
- Number of victims
- Other relevant incident details
This structured information helps the backend and dispatcher work with a more consistent emergency record.
3. Smart Ambulance Recommendation
RapidAid provides ambulance recommendations based on available operational information.

Relevant signals include:
- Ambulance availability
- Proximity
- Crew information
- Represented operational capabilities
The recommendation is intended to support the dispatcher rather than automatically make the final dispatch decision.
4. Human-in-the-Loop Dispatch
RapidAid deliberately keeps an authorized dispatcher involved in the final decision.

The dispatcher can:
- Review the emergency information.
- Review the ambulance recommendation.
- Correct or update information where necessary.
- Confirm an ambulance assignment.
- Override a recommendation when required.
This approach is important because AI-assisted information and recommendations can contain errors or incomplete information.
5. Emergency Lifecycle Management
Each emergency follows a structured lifecycle so that responders can clearly understand the current stage.

The seven supported statuses are:
REPORTED
    ↓
AMBULANCE_ASSIGNED
    ↓
EN_ROUTE
    ↓
AT_SCENE
    ↓
PATIENT_ONBOARD
    ↓
AT_HOSPITAL
    ↓
COMPLETED
6. Map and Route Support
RapidAid provides map-based response support and uses OSRM (Open Source Routing Machine) for route calculation.

The route system can help represent:
- Incident location
- Ambulance route
- Destination/hospital route
- Response movement
OSRM is a routing engine. It is not a GPS tracking system.

The GPS movement and telemetry used in the demonstration are simulated.
7. Hospital Coordination
The system includes a hospital coordination workflow connected to the emergency response process.

The workflow can associate an emergency with a destination hospital and maintain relevant reservation/coordination information.

The demonstration uses synthetic hospital data.
8. Role-Based Access Control
RapidAid uses role-based access control (RBAC) to separate system capabilities between users.

The three main roles are:
- Citizen
- Dispatcher
- Ambulance Crew
🔄 How RapidAid Works
Citizen
   |
   | Emergency report
   v
React + TypeScript Frontend
   |
   | Voice/Text
   v
Speech-to-Text
(Whisper-base)
   |
   v
AI-Assisted Information Extraction
   |
   | Structured emergency information
   v
Node.js + Express Backend
   |
   +----------------------+
   |                      |
   v                      v
MongoDB Atlas        Ambulance Recommendation
                           |
                           v
                    Dispatcher Review
                           |
                           v
                    Final Assignment
                           |
                           v
                  Emergency Lifecycle
                           |
                           v
                 Route / Hospital Support
                           |
                           v
                       COMPLETED
🔁 Emergency Lifecycle
Status	Meaning
REPORTED	Emergency report has been submitted
AMBULANCE_ASSIGNED	An ambulance has been assigned
EN_ROUTE	Ambulance is travelling to the incident
AT_SCENE	Ambulance has reached the incident
PATIENT_ONBOARD	Patient has been taken into the ambulance
AT_HOSPITAL	Ambulance has reached the hospital
COMPLETED	Response workflow is completed


👥 User Roles
Citizen
The Citizen reports an emergency using text or voice and provides incident/location information.
Dispatcher
The Dispatcher:
- Reviews reported emergencies.
- Reviews extracted information.
- Reviews ambulance recommendations.
- Confirms or overrides ambulance assignments.
- Monitors emergency status.
- Coordinates the response workflow.
Ambulance Crew
The Ambulance Crew:
- Receives assignment information.
- Updates response status.
- Progresses the emergency through the lifecycle.
- Completes the response/hospital workflow.
🏗️ System Architecture
                    ┌──────────────────────────┐
                    │          Users           │
                    │ Citizen / Dispatcher /   │
                    │      Ambulance Crew      │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │ React + TypeScript + Vite│
                    │        Frontend          │
                    └────────────┬─────────────┘
                                 │
                           REST / JSON
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │ Node.js + Express +      │
                    │      TypeScript          │
                    │         Backend          │
                    └───────┬──────────┬───────┘
                            │          │
                            │          ├──────────────┐
                            │          │              │
                            ▼          ▼              ▼
                     ┌──────────┐  AI-assisted     OSRM
                     │ Mongoose │  Processing     Routing
                     └────┬─────┘
                          │
                          ▼
                   ┌─────────────┐
                   │ MongoDB Atlas│
                   └─────────────┘

Browser-side AI:
Transformers.js + Whisper-base + ONNX Runtime Web
🧰 Technology Stack
Category	Technology	Purpose
Frontend	React	User interface
Frontend Language	TypeScript	Type-safe application development
Frontend Tooling	Vite	Development server and production build
Backend Runtime	Node.js	Server-side execution
Backend Framework	Express.js	REST API and server framework
Backend Language	TypeScript	Type-safe backend development
Database	MongoDB Atlas	Cloud document database
Database Layer	Mongoose	MongoDB object-document mapping
Speech Processing	Whisper-base	Speech-to-text
Browser AI	Transformers.js	Browser model integration
Model Runtime	ONNX Runtime Web	Browser model execution
Routing	OSRM	Route calculation
Hosting	Render	Frontend/backend deployment


🤖 AI and Intelligent Processing
RapidAid uses AI in multiple stages, with separate responsibilities.
Speech Recognition
Voice
  ↓
Whisper-base
  ↓
Text Transcript
Whisper's responsibility is speech-to-text conversion.
Information Extraction
Transcript / Report
        ↓
AI-assisted Processing
        ↓
Structured Incident Information
This helps convert an unstructured report into useful emergency fields.
Ambulance Recommendation
Emergency Information
        +
Available Ambulances
        +
Operational Information
        ↓
Recommendation
        ↓
Dispatcher Review
        ↓
Final Assignment
The recommendation does not replace the dispatcher.
🚑 Ambulance Recommendation
RapidAid does not simply select the nearest ambulance.

The recommendation can consider:
- Availability
- Proximity
- Crew information
- Represented operational capabilities
For example:
Ambulance A
Distance: Very close
Availability: Available
Capabilities: Limited

Ambulance B
Distance: Slightly farther
Availability: Available
Capabilities: Better suited
The closer ambulance is not automatically the best choice if another available resource is operationally more suitable.

The exact recommendation depends on the information represented in the system.

The dispatcher retains final authority over assignment.
🗺️ Map and Routing
RapidAid uses OSRM for route support.
Origin
  ↓
OSRM Routing Service
  ↓
Route
  ↓
Frontend Map
OSRM calculates routes; it does not provide physical GPS hardware data from an ambulance.

GPS movement and telemetry used in the demonstration are simulated.
🏥 Hospital Coordination
Hospital coordination is another stage of the emergency workflow.

The system can associate an emergency with a hospital destination and maintain coordination information.

The demonstration uses synthetic hospital records.

Real hospital-system integration is part of the future scope.
🔐 Authentication and RBAC
Authentication
Authentication answers:
“Who is this user?”

Authorization
Authorization answers:
“What is this user allowed to do?”

RapidAid separates permissions according to:
Citizen
   ↓
Citizen functions

Dispatcher
   ↓
Dispatch / coordination functions

Ambulance Crew
   ↓
Response / status functions
🧪 Demo Scenario
The demonstration uses a synthetic vehicle-collision scenario.
Incident
Emergency ID: EMG-00003
Incident: Vehicle collision
Location: Near Maharaj Bada, Gwalior
Severity: CRITICAL
Victims: 2
Ambulance
Ambulance: AMB-053
Crew:
- C035 Vikram Singh
- C036 Anita Patel
The demonstration shows an ambulance recommendation score of approximately 86.3 and a distance of approximately 5.5 km.
Hospital
Hospital: HOSP-82
Gwalior Trauma & Multi-Specialty Center
Demonstration lifecycle
Vehicle Collision
      ↓
Emergency Report
      ↓
AI-assisted Information Processing
      ↓
Ambulance Recommendation
      ↓
Dispatcher Assignment
      ↓
EN_ROUTE
      ↓
AT_SCENE
      ↓
PATIENT_ONBOARD
      ↓
AT_HOSPITAL
      ↓
COMPLETED
This is a synthetic scenario. It does not represent a real emergency, real ambulance dispatch, live ambulance GPS hardware, real hospital integration, or communication with government emergency services.
📁 Project Structure
The project uses a frontend-at-root and backend-in-`server` organization.
RapidAid/
│
├── src/                    # Frontend application
├── public/                 # Frontend public assets
├── server/                 # Backend application
├── package.json            # Root/frontend scripts and dependencies
├── README.md
└── configuration files
The exact file tree and script names may change as the project evolves. The current repository is the authoritative source.
💻 Local Development
Prerequisites
- Node.js
- npm
- Git
- MongoDB Atlas account or configured MongoDB instance
Recommended development tools:
- VS Code / Antigravity
- Git
- Docker
- MongoDB Compass
1. Clone
git clone https://github.com/shivam123yadav/RapidAid.git
cd RapidAid
2. Install frontend dependencies
npm install
3. Install backend dependencies
npm --prefix server install
4. Check available scripts
npm run
npm --prefix server run
Use the development scripts actually defined in the current package.json files.
5. Configure environment
Create the environment files required by the current frontend and backend configuration.

Configuration may include:
- MongoDB connection
- Authentication settings
- AI/service settings
- Application ports
- Frontend/backend URLs
Use the exact variable names referenced by the current source code. Never commit secrets or .env files.
6. Start the application
Start the frontend and backend using their configured development scripts.
🔧 Environment Configuration
RapidAid requires environment-specific configuration for services such as the database and authentication.

Security practices:
- Keep secrets outside source code.
- Use .env locally.
- Add .env to .gitignore.
- Never commit database passwords or API keys.
- Configure production variables securely on Render.
The exact environment-variable names should be taken from the current repository configuration rather than an outdated README.
🧪 Testing and Validation
At the recorded validation checkpoint:
Backend
790 tests passed
58 test files passed
Frontend
127 tests passed
9 test files passed
Build validation
Backend production build → PASSED
Frontend typecheck       → PASSED
Frontend production build → PASSED
These results describe the tested project state at that checkpoint.

They do not establish:
- Real-world emergency response performance
- AI accuracy
- Whisper accuracy
- Average speech-processing latency
- Production-scale throughput
- Clinical validity
- Field reliability
- Government emergency-service integration
🎙️ Whisper Accuracy and Processing Time
RapidAid uses Whisper-base for speech-to-text.

A formal benchmark was not established for:
- Word Error Rate (WER)
- Character Error Rate (CER)
- Average processing time per audio clip
- Accuracy across different languages
- Accuracy under background noise
- Hardware-specific latency
Therefore, the project should not claim an unverified accuracy percentage or average processing time.

Future evaluation should use representative Hindi, English, and Hinglish samples and report metrics such as WER and average processing time.
🧪 Playwright Test Count
The validated project information contains overall frontend and backend test counts, but a separate Playwright-specific count has not been established.

Verified counts are:
Backend: 790 tests
Frontend: 127 tests
These should not automatically be described as Playwright tests.

A separate Playwright count should be calculated directly from the current Playwright test files if required.
🚀 Deployment
RapidAid has been deployed using Render.
Frontend
https://rapidaid-web.onrender.com
Backend
https://rapidaid-api-vpms.onrender.com
GitHub
https://github.com/shivam123yadav/RapidAid

Production deployment requires correctly configured environment variables and service settings.
🔒 Security Considerations
Important security areas include:
- Authentication
- Authorization/RBAC
- Secure secret management
- Input validation
- Database access control
- Secure API communication
- Error handling
- Auditability of important operational actions
- Protection of sensitive information
The academic prototype should not be interpreted as security-certified or production-ready for real emergency-service deployment.
⚠️ Limitations
No official emergency-service integration
RapidAid is not integrated with 108, 112, government ambulance systems, or official emergency dispatch infrastructure.
No real ambulance hardware integration
The demonstration does not use physical ambulance GPS hardware or live telemetry.
No real hospital integration
The hospital workflow uses synthetic/project data rather than live hospital systems.
AI limitations
AI-assisted extraction and recommendations can be wrong or incomplete. Human review remains important.
No formal Whisper benchmark
The project does not currently claim a measured Whisper accuracy percentage or average processing latency.
No field validation
The system has not been validated through real-world emergency-service deployment.
🔮 Future Scope
Live GPS and telemetry
Integrate authorized ambulance GPS hardware and live location updates.
Emergency-service integration
Develop secure, authorized integration with official emergency-response infrastructure.
Hospital integration
Connect with hospital systems for real-time destination availability and coordination.
Better AI evaluation
Evaluate:
- Speech recognition accuracy
- Information extraction accuracy
- Recommendation quality
- False-positive/false-negative behavior
- Response workflow reliability
Performance benchmarking
Measure:
- API latency
- Speech-processing latency
- Database performance
- Concurrent-user capacity
- End-to-end workflow time
Advanced prediction
Future versions could explore:
- Emergency demand prediction
- Ambulance positioning
- Traffic-aware ETA
- Resource optimization
- Hospital capacity prediction
Any such capability would require appropriate validation before real-world use.
📊 Project Impact
RapidAid connects:
Emergency Reporting
        ↓
Speech / Text Processing
        ↓
Structured Information
        ↓
Ambulance Recommendation
        ↓
Human Review
        ↓
Dispatch
        ↓
Response Tracking
        ↓
Hospital Coordination
        ↓
Completion
The primary contribution is system-level coordination, rather than claiming a completely new AI algorithm.

The project combines existing technologies into an emergency-response workflow designed to improve organization, visibility, and decision support.
🏆 Key Technical Concepts Demonstrated
- React
- TypeScript
- Vite
- Node.js
- Express.js
- REST APIs
- JSON
- MongoDB
- MongoDB Atlas
- Mongoose
- Authentication
- Authorization
- RBAC
- AI-assisted information processing
- Speech-to-text
- Transformers.js
- Whisper
- ONNX Runtime Web
- OSRM routing
- Map-based interfaces
- State-based workflow management
- Automated testing
- Production builds
- Cloud deployment
👨‍💻 Team
Shivam Yadav
Developer / Project Team Member
Yash Kumar
Developer / Project Team Member
🔗 Project Links
GitHub Repository:
https://github.com/shivam123yadav/RapidAid

Live Frontend:
https://rapidaid-web.onrender.com

Backend API:
https://rapidaid-api-vpms.onrender.com
📜 License
Add the project's actual license here if a license has been added to the repository.

If the repository does not currently contain a license, do not claim a specific open-source license.
⚠️ Safety Disclaimer
RapidAid is an academic and demonstration prototype for emergency-response coordination.

It is not a medical device, does not replace trained emergency personnel, and does not replace official emergency services.

AI-generated or extracted information may be incomplete or incorrect and should be reviewed by authorized personnel.

The demonstration uses synthetic data and simulated GPS/telemetry. It does not perform real emergency dispatch or provide guaranteed emergency response.

For a real emergency in India, use the appropriate official emergency services, such as 112 or 108, as applicable.
📌 Summary
RapidAid connects emergency reporting, speech-to-text, AI-assisted information extraction, ambulance recommendation, dispatcher-controlled assignment, response lifecycle management, route support, and hospital coordination into one web-based workflow.

Its core principle is:
AI assists the response team; authorized humans remain in control of critical decisions.
