import { Jackett } from "./services/jackett";
import { Sonarr } from "./services/sonarr";
import { Radarr } from "./services/radarr";
import { Lidarr } from "./services/lidarr";
import { Readarr } from "./services/readarr";
import { Service } from "./services/service";
import { JackettIndexer } from "./models/jackettIndexer";

async function start() {
  let jackettIndexers: JackettIndexer[];

  try {
    const jackett = new Jackett();
    jackettIndexers = await jackett.getIndexers();
  } catch (error) {
    console.error(
      `[${Jackett.name}] Couldn't get indexers: `,
      (error as Error).message
    );
    process.exit(1);
  }

  const services: Service[] = [
    new Sonarr(),
    new Radarr(),
    new Lidarr(),
    new Readarr(),
  ];

  await Promise.all(
    services.map(async (service) => {
      try {
        await sync(service, jackettIndexers);
      } catch (error) {
        console.error(
          `[${service.serviceName}] Sync failed:`,
          (error as Error).message
        );
      }
    })
  );
}

async function sync(service: Service, jackettIndexers: JackettIndexer[]) {
  try {
    const response = await service.validate();
    console.log(
      `[${service.serviceName}] Tested url & apiKey, running version ${response.data.version}`
    );

    await service.getIndexers();
    console.log(`[${service.serviceName}] Starting sync`);

    await service.sync(jackettIndexers);

    console.log(`[${service.serviceName}] Sync is done!`);
  } catch (error: any) {
    console.error(`[${service.serviceName}] Failed:`, error.message);
  }
}

void start();
