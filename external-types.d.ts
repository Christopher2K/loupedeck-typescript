declare module "color-rgba" {
  export default function rgba(color: string): number[];
}

interface ImportMeta {
  env?: {
    PROD?: boolean;
  };
}
