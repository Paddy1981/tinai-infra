-- Instance images catalog
CREATE TABLE instance_images (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,          -- e.g. "pytorch-v2.8"
  name          TEXT NOT NULL,                  -- "PyTorch"
  version       TEXT NOT NULL,                  -- "v2.8"
  category      TEXT NOT NULL CHECK (category IN ('pre-built','base-os','custom')),
  framework     TEXT,                           -- "pytorch", "tensorflow", "vllm", etc.
  cuda_version  TEXT,                           -- "12.9.1"
  python_version TEXT,                          -- "3.12"
  os_version    TEXT NOT NULL DEFAULT 'ubuntu-22.04',
  description   TEXT NOT NULL,
  docker_image  TEXT NOT NULL,                  -- registry.tinai.cloud/tinai/instances/<slug>:latest
  tags          TEXT[] NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GPU / CPU instance type SKUs
CREATE TABLE instance_types (
  id                  SERIAL PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,     -- "gpu-rtx4090-1x"
  name                TEXT NOT NULL,            -- "RTX 4090 · 1×"
  category            TEXT NOT NULL CHECK (category IN ('gpu','cpu')),
  gpu_model           TEXT,                     -- "NVIDIA RTX 4090"
  gpu_count           INT NOT NULL DEFAULT 0,
  vram_gb             INT,
  vcpu                INT NOT NULL,
  ram_gb              INT NOT NULL,
  storage_gb          INT NOT NULL DEFAULT 50,
  price_per_hour_paise INT NOT NULL,            -- ₹ stored as paise (100 paise = ₹1)
  is_available        BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Running/stopped instances per tenant
CREATE TABLE instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,                -- user-given name
  image_id        INT NOT NULL REFERENCES instance_images(id),
  instance_type_id INT NOT NULL REFERENCES instance_types(id),
  status          TEXT NOT NULL DEFAULT 'provisioning'
                    CHECK (status IN ('provisioning','running','stopping','stopped','error')),
  pod_name        TEXT,                         -- K8s pod name
  namespace       TEXT,                         -- K8s namespace
  ssh_host        TEXT,
  ssh_port        INT,
  jupyter_url     TEXT,
  volume_size_gb  INT NOT NULL DEFAULT 50,
  started_at      TIMESTAMPTZ,
  stopped_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX instances_tenant_id_idx ON instances(tenant_id);
CREATE INDEX instances_status_idx ON instances(status);

-- Seed: instance images catalog
INSERT INTO instance_images (slug, name, version, category, framework, cuda_version, python_version, os_version, description, docker_image) VALUES
('pytorch-v2.8',        'PyTorch',        'v2.8',              'pre-built', 'pytorch',      '12.9.1', '3.12', 'ubuntu-24.04', 'NVIDIA optimised PyTorch v2.8 with Python 3.12 and NVIDIA CUDA 12.9.1 pre-installed on Ubuntu 24.04',      'registry.tinai.cloud/tinai/instances/pytorch:v2.8'),
('transformers-v4.51',  'Transformers',   'v4.51.3',           'pre-built', 'transformers', '12.4',   '3.10', 'ubuntu-22.04', 'Transformers v4.51.3 with Python 3.10 and NVIDIA CUDA 12.4 pre-installed on Ubuntu 22.04',                'registry.tinai.cloud/tinai/instances/transformers:v4.51.3'),
('tensorflow-v2.15',    'TensorFlow',     'v2.15.0',           'pre-built', 'tensorflow',   '12.4',   '3.10', 'ubuntu-22.04', 'NVIDIA optimised TensorFlow 2 (v2.15.0) with Python 3.10 and NVIDIA CUDA 12.4 pre-installed on Ubuntu 22.04','registry.tinai.cloud/tinai/instances/tensorflow:v2.15.0'),
('diffusers-v0.27',     'Diffusers',      'v0.27.2',           'pre-built', 'diffusers',    '12.4',   '3.10', 'ubuntu-22.04', 'Diffusers v0.27.2 with Python 3.10 and NVIDIA CUDA 12.4 pre-installed on Ubuntu 22.04',                  'registry.tinai.cloud/tinai/instances/diffusers:v0.27.2'),
('vllm-v0.15',          'vLLM',           'v0.15.1',           'pre-built', 'vllm',         '12.9',   '3.12', 'ubuntu-22.04', 'vLLM v0.15.1 with NVIDIA CUDA 12.9, Transformers v4.57.6, Python 3.12.12 pre-installed on Ubuntu 22.04', 'registry.tinai.cloud/tinai/instances/vllm:v0.15.1'),
('nemo-v2.6',           'NVIDIA NeMo',    'v2.6.0',            'pre-built', 'nemo',         '13.0',   '3.12', 'ubuntu-24.04', 'NeMo v2.6.0 with Python 3.12 and NVIDIA CUDA 13.0 installed on Ubuntu 24.04',                           'registry.tinai.cloud/tinai/instances/nemo:v2.6.0'),
('triton-v2.59',        'Triton',         'v2.59.0',           'pre-built', 'triton',       '12.9',   '3.12', 'ubuntu-24.04', 'Triton v2.59.0 with Python 3.12 and NVIDIA CUDA 12.9 installed on Ubuntu 24.04',                        'registry.tinai.cloud/tinai/instances/triton:v2.59.0'),
('comfyui-v0.11',       'ComfyUI',        'v0.11.1',           'pre-built', 'comfyui',      '12.4',   '3.10', 'ubuntu-22.04', 'ComfyUI v0.11.1 with PyTorch v2.10.0 and ComfyUI Manager pre-installed on Ubuntu 22.04',                 'registry.tinai.cloud/tinai/instances/comfyui:v0.11.1'),
('jupyter-cuda12',      'Jupyter',        'CUDA-12.1.0',       'pre-built', 'jupyter',      '12.1',   '3.10', 'ubuntu-22.04', 'Jupyter base image with Python 3.10 and NVIDIA CUDA 12.1 pre-installed on Ubuntu 22.04',                 'registry.tinai.cloud/tinai/instances/jupyter:cuda12.1'),
('rapids-v23.06',       'NVIDIA RAPIDS',  'v23.06',            'pre-built', 'rapids',       '12.1',   '3.10', 'ubuntu-20.04', 'NVIDIA RAPIDS 23.06 with Python 3.10 and NVIDIA CUDA 12.1 pre-installed on Ubuntu 20.04',                'registry.tinai.cloud/tinai/instances/rapids:v23.06'),
('fastai-v2.7',         'Fast.AI',        'v2.7.14',           'pre-built', 'fastai',       '12.1',   '3.10', 'ubuntu-22.04', 'Fast.AI v2.7.14 with Python 3.10 and NVIDIA CUDA 12.1 pre-installed on Ubuntu 22.04',                   'registry.tinai.cloud/tinai/instances/fastai:v2.7.14'),
('tensorrt-llm-v0.12',  'TensorRT-LLM',   'v0.12.0',           'pre-built', 'tensorrt-llm', '12.4',   '3.10', 'ubuntu-22.04', 'Image for building engine for Triton TensorRT-LLM v0.12.0',                                            'registry.tinai.cloud/tinai/instances/tensorrt-llm:v0.12.0'),
('python310-cuda12',    'Python 3.10',    'CUDA-12.2',         'base-os',   NULL,           '12.2',   '3.10', 'ubuntu-22.04', 'A Python 3.10 base image with NVIDIA CUDA 12.2 pre-installed on Ubuntu 22.04',                          'registry.tinai.cloud/tinai/instances/python310:cuda12.2'),
('ubuntu-22.04',        'Ubuntu',         '22.04',             'base-os',   NULL,           NULL,     '3.10', 'ubuntu-22.04', 'Ubuntu 22.04 base image with Python 3.10',                                                               'registry.tinai.cloud/tinai/instances/ubuntu:22.04');

-- Seed: instance type SKUs — E2E Networks India pricing (paise; 100 paise = ₹1)
INSERT INTO instance_types (slug, name, category, gpu_model, gpu_count, vram_gb, vcpu, ram_gb, storage_gb, price_per_hour_paise) VALUES
('gpu-l4-1x',       'L4 24GB · 1×',     'gpu', 'NVIDIA L4',          1, 24,  8,  32,  50,   7000),  -- ₹70/hr
('gpu-l4-2x',       'L4 24GB · 2×',     'gpu', 'NVIDIA L4',          2, 48,  16, 64,  50,  14000),  -- ₹140/hr
('gpu-a100-1x',     'A100 80GB · 1×',   'gpu', 'NVIDIA A100 SXM4',   1, 80,  32, 128, 50,  17000),  -- ₹170/hr
('gpu-a100-8x',     'A100 80GB · 8×',   'gpu', 'NVIDIA A100 SXM4',   8, 640, 192,768, 50, 120000),  -- ₹1200/hr
('gpu-h100-1x',     'H100 80GB · 1×',   'gpu', 'NVIDIA H100 SXM5',   1, 80,  32, 128, 50,  24900),  -- ₹249/hr
('gpu-h100-8x',     'H100 80GB · 8×',   'gpu', 'NVIDIA H100 SXM5',   8, 640, 192,768, 50, 179200),  -- ₹1792/hr
('cpu-8core',       'CPU · 8 vCPU',     'cpu', NULL,                  0, NULL, 8,  32,  50,   2500),  -- ₹25/hr
('cpu-32core',      'CPU · 32 vCPU',    'cpu', NULL,                  0, NULL, 32, 128, 50,   8900);  -- ₹89/hr
