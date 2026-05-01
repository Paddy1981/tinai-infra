// Package detect provides zero-config language and framework detection for
// arbitrary git repositories. Given a local directory path it inspects the
// repository's files and returns a BuildPlan describing the runtime, build
// command, start command, port, and an auto-generated Dockerfile.
package detect

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// BuildPlan holds everything needed to build and run a detected application.
type BuildPlan struct {
	Runtime    string `json:"runtime"`    // "node", "python", "go", "docker", "static"
	Framework  string `json:"framework"`  // "nextjs", "fastapi", "django", "react", "vue", ""
	BuildCmd   string `json:"build_cmd"`  // e.g. "npm run build"
	StartCmd   string `json:"start_cmd"`  // e.g. "node server.js"
	Port       int    `json:"port"`       // detected or default port
	Dockerfile string `json:"dockerfile"` // generated (or empty when Dockerfile exists)
}

// Detect inspects the directory at dir and returns a BuildPlan.
// Detection order:
//  1. Dockerfile present → runtime "docker", use as-is
//  2. package.json → Node; inspect contents for Next.js / React / plain Node
//  3. requirements.txt or pyproject.toml → Python; inspect for FastAPI / Django
//  4. go.mod → Go
//  5. index.html → static (served by nginx)
func Detect(dir string) (BuildPlan, error) {
	has := func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return err == nil
	}
	readFile := func(name string) string {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return ""
		}
		return string(b)
	}

	// 1. Dockerfile already present — use it as-is.
	if has("Dockerfile") {
		return BuildPlan{
			Runtime: "docker",
			Port:    8080,
		}, nil
	}

	// 2. Node / JavaScript project.
	if has("package.json") {
		return detectNode(dir, readFile("package.json")), nil
	}

	// 3. Python project.
	if has("requirements.txt") || has("pyproject.toml") {
		reqs := strings.ToLower(readFile("requirements.txt") + readFile("pyproject.toml"))
		return detectPython(reqs), nil
	}

	// 4. Go project.
	if has("go.mod") {
		return detectGo(readFile("go.mod")), nil
	}

	// 5. Static site (plain HTML).
	if has("index.html") {
		plan := BuildPlan{
			Runtime:    "static",
			Framework:  "",
			BuildCmd:   "",
			StartCmd:   "",
			Port:       80,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan, nil
	}

	return BuildPlan{Runtime: "unknown", Port: 8080}, nil
}

// ---------- runtime-specific helpers ----------

// packageJSON is used to parse the relevant fields of package.json.
type packageJSON struct {
	Scripts      map[string]string      `json:"scripts"`
	Dependencies map[string]interface{} `json:"dependencies"`
	DevDeps      map[string]interface{} `json:"devDependencies"`
}

func detectNode(dir, raw string) BuildPlan {
	var pkg packageJSON
	if err := json.Unmarshal([]byte(raw), &pkg); err != nil {
		log.Printf("detect: parse package.json: %v", err)
	}

	hasDep := func(name string) bool {
		_, inDeps := pkg.Dependencies[name]
		_, inDevDeps := pkg.DevDeps[name]
		return inDeps || inDevDeps
	}

	// Check for next.config.* files as a secondary signal.
	hasNextConfig := func() bool {
		for _, name := range []string{"next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"} {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				return true
			}
		}
		return false
	}

	// Next.js
	if hasDep("next") || hasNextConfig() {
		plan := BuildPlan{
			Runtime:   "node",
			Framework: "nextjs",
			BuildCmd:  "npm run build",
			StartCmd:  "node .next/standalone/server.js",
			Port:      3000,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan
	}

	// Create React App
	if hasDep("react-scripts") {
		plan := BuildPlan{
			Runtime:   "node",
			Framework: "react",
			BuildCmd:  "npm run build",
			StartCmd:  "",
			Port:      3000,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan
	}

	// Vite (React or Vue)
	if hasDep("vite") {
		framework := "react"
		if hasDep("vue") {
			framework = "vue"
		}
		plan := BuildPlan{
			Runtime:   "node",
			Framework: framework,
			BuildCmd:  "npm run build",
			StartCmd:  "",
			Port:      3000,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan
	}

	// Plain Node — derive StartCmd from scripts.start if present.
	startCmd := "node index.js"
	if s, ok := pkg.Scripts["start"]; ok && s != "" {
		startCmd = s
	}
	plan := BuildPlan{
		Runtime:   "node",
		Framework: "",
		BuildCmd:  "",
		StartCmd:  startCmd,
		Port:      3000,
	}
	plan.Dockerfile = GenerateDockerfile(plan)
	return plan
}

func detectPython(reqs string) BuildPlan {
	// FastAPI check (also catches fastapi[all] etc.)
	if strings.Contains(reqs, "fastapi") {
		// Determine entry-point: look for main.py/app.py/api.py heuristic.
		// Default to main:app which is the FastAPI convention.
		plan := BuildPlan{
			Runtime:   "python",
			Framework: "fastapi",
			BuildCmd:  "",
			StartCmd:  "uvicorn main:app --host 0.0.0.0 --port 8000",
			Port:      8000,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan
	}

	// Django
	if strings.Contains(reqs, "django") {
		plan := BuildPlan{
			Runtime:   "python",
			Framework: "django",
			BuildCmd:  "python manage.py collectstatic --noinput",
			StartCmd:  "gunicorn config.wsgi:application --bind 0.0.0.0:8000",
			Port:      8000,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan
	}

	// Flask
	if strings.Contains(reqs, "flask") {
		plan := BuildPlan{
			Runtime:   "python",
			Framework: "flask",
			BuildCmd:  "",
			StartCmd:  "gunicorn app:app --bind 0.0.0.0:8000",
			Port:      8000,
		}
		plan.Dockerfile = GenerateDockerfile(plan)
		return plan
	}

	// Generic Python
	plan := BuildPlan{
		Runtime:   "python",
		Framework: "",
		BuildCmd:  "",
		StartCmd:  "python main.py",
		Port:      8000,
	}
	plan.Dockerfile = GenerateDockerfile(plan)
	return plan
}

func detectGo(goMod string) BuildPlan {
	plan := BuildPlan{
		Runtime:   "go",
		Framework: "",
		BuildCmd:  "go build -o app .",
		StartCmd:  "./app",
		Port:      8080,
	}
	// Detect Gin / Echo / Fiber for informational purposes.
	lower := strings.ToLower(goMod)
	switch {
	case strings.Contains(lower, "github.com/gin-gonic/gin"):
		plan.Framework = "gin"
	case strings.Contains(lower, "github.com/labstack/echo"):
		plan.Framework = "echo"
	case strings.Contains(lower, "github.com/gofiber/fiber"):
		plan.Framework = "fiber"
	}
	plan.Dockerfile = GenerateDockerfile(plan)
	return plan
}

// formatCMD converts a space-separated shell command into a JSON-array CMD
// literal for use inside a Dockerfile CMD instruction.
// Example: "uvicorn main:app" → `"uvicorn", "main:app"`
func formatCMD(cmd string) string {
	parts := strings.Fields(cmd)
	quoted := make([]string, len(parts))
	for i, p := range parts {
		quoted[i] = fmt.Sprintf("%q", p)
	}
	return strings.Join(quoted, ", ")
}
