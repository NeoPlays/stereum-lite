import { SSHService } from "@main/ssh/SSHService";

export class EthNode {
    constructor(sshService) {
        this.sshService = sshService;
    }
    toDTO(){
        return {
            name: this.sshService.SSHParams.name,
            host: this.sshService.SSHParams.host,
        }
    }
}