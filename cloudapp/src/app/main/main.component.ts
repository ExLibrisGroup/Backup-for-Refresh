import { catchError, concatMap, finalize, map, mergeMap, tap } from 'rxjs/operators';
import { Component, OnInit, ElementRef, ViewChild, AfterContentChecked, SimpleChanges, OnChanges } from '@angular/core';
import { CloudAppRestService, CloudAppEventsService, Request, HttpMethod,  AlertService, CloudAppStoreService, Entity } from '@exlibris/exl-cloudapp-angular-lib';
import { saveAs } from 'file-saver-es';
import { SelectEntitiesComponent } from 'eca-components';
import { from, Observable, of } from 'rxjs';
import { equal } from 'assert';


@Component({
  selector: 'app-main',
  templateUrl: './main.component.html',
  styleUrls: ['./main.component.scss']
})
export class MainComponent implements OnInit, AfterContentChecked ,OnChanges{

  loading = false;
  selectedEntities = {"users": [], "integration_profiles": [] , "allowed_emails" :[] ,"allowed_ftps" :[]}
  updatedUsers = 0
  createdUsers = 0
  failedUsers = 0
  updatedEmails = 0
  updatedFtps = 0
  updateLogText = ""
  updatedIP = 0
  createdIP = 0
  failedIP =0
  upload_integration_profiles = []

  entities$ = this.eventsService.entities$;
  @ViewChild('FILE') FILE: ElementRef;
  @ViewChild(SelectEntitiesComponent) selectEntitiesComponent: SelectEntitiesComponent;

  constructor(
    private restService: CloudAppRestService,
    private eventsService: CloudAppEventsService,
    private alert: AlertService,
    private storeService: CloudAppStoreService 
  ) {}

  ngAfterContentChecked(){
    this.checkOnLoad()
  }

  ngOnInit() {
    this.loading = true;
    this.storeService.get("Users").pipe(finalize(() => {this.loading = false })).subscribe( records => {
      if (records) {
        this.selectedEntities.users = records;  
      }
      this.selectEntitiesComponent.selected = this.selectedEntities.users;
    })
    this.restService.call('/conf/integration-profiles?limit=100').subscribe(result =>
      this.selectedEntities.integration_profiles = result['integration_profile']) 
    this.restService.call('/conf/mapping-tables/EmailIncludeList').subscribe(result =>
        this.selectedEntities.allowed_emails = result['row']) 
    this.restService.call('/conf/mapping-tables/FtpIncludeList').subscribe(result =>
      this.selectedEntities.allowed_ftps = result['row'])
  }

  onUpload() {
    document.getElementById('getFile').click()
  }

  entitySelected() { 
    if (this.selectEntitiesComponent == undefined){
      return
    }
    this.storeService.set("Users", this.selectedEntities.users).subscribe(response=>{console.log('Saved');}, 
      error => console.log('Failed to save entitiy: ' + error.message))      
  }

  save() {
    const selectedApi = {"users": [], "integration_profiles": this.selectedEntities.integration_profiles , "allowed_emails" :this.selectedEntities.allowed_emails ,"allowed_ftps":this.selectedEntities.allowed_ftps}
    this.loading = true;
    const users = this.selectedEntities.users;

    from(users).pipe(
      mergeMap(user => {    
        return this.restService.call<any>(user.link).pipe(
          map(result => selectedApi.users.push(result)),
          catchError(error => {this.alert.error('Failed to retrieve entity: ' + error.message); return of(Observable)}),
        )
      }),
      finalize(() => {
        let str = JSON.stringify(selectedApi, null, 3)         
        let file = new Blob([str], { type: 'json;charset=utf-8'})
        saveAs(file, 'Backup.txt')
        this.loading = false;})
    ).subscribe() 
  }

  upload(file: File) {
    this.loading = true
    file = file[0];
    const reader = new FileReader();
    reader.readAsText(file)
    this.FILE.nativeElement.value = ""
    this.updateLogText = ""
    reader.onload = () => {  
      let upload = this.tryParseJson(reader.result.toString())
      if (upload !== undefined) { // File is not empty
        if (upload.integration_profiles !== undefined) { // Integration profiles array exist
          this.upload_integration_profiles = upload.integration_profiles
          from(this.upload_integration_profiles).pipe(
            mergeMap((integrationProfile: any) => {
              let url = "/conf/integration-profiles/" + integrationProfile.id     
              return this.restService.call<any>(url).pipe(
                concatMap(() =>  this.update(integrationProfile, url,"integration-profiles")), // Integration Profile exists - update it
                catchError(error => {
                  if (error.status === 400) { // Integration Profile doesn't exist - create new  
                    return this.create(integrationProfile,'/conf/integration-profiles','integration-profiles');
                  } else {
                    this.alert.error('Failed to retrieve entity: ' + error.message);
                    return of(Observable);
                  }
                }),
              )
            }),
            finalize(() => this.printIPAlertMessage())
          ).subscribe() 

        }
        if (upload.users !== undefined) { // Users array exist
          from(upload.users).pipe(
            mergeMap((user: any) => {
              let url = "/users/" + user.primary_id     
              return this.restService.call<any>(url).pipe(
                concatMap(() =>  this.update(user, url,"users")), // User exists - update it
                catchError(error => {
                  if (error.status === 400) { // User doesn't exist - create new  
                    return this.create(user,'/users','users');
                  } else {
                    this.alert.error('Failed to retrieve entity: ' + error.message);
                    return of(Observable);
                  }
                }),
              )
            }),
            finalize(() => this.printAlertMessage())
          ).subscribe() 
        }
        else { // Users array doesn't exist       
          this.printAlertMessage()
          this.loading = false;
        } 
        if (upload.allowed_emails !== undefined) { // Allowed Emails array exist
          this.restService.call('/conf/mapping-tables/EmailIncludeList').subscribe({
            next: result => {
              result['row'] = upload.allowed_emails;
              this.sendUpdateRequest( '/conf/mapping-tables/EmailIncludeList',result,'Emails') // Allowed Emails exists - swapping
            },
            error: (e) => {
              this.alert.error('Failed to update Allowed Emails: ' + e.message);
              console.error(e);
            }
            
          });
        }
        if (upload.allowed_ftps !== undefined) { // Allowed S/FTP connections array exist
          this.restService.call('/conf/mapping-tables/FtpIncludeList').subscribe({
            next: result => {
              result['row'] = upload.allowed_ftps;
              this.sendUpdateRequest('/conf/mapping-tables/FtpIncludeList',result,'S/FTP connections') // Allowed S/FTP connections exists - swapping
            },
            error: (e) => {
              this.alert.error('Failed to update Allowed S/FTP connections: ' + e.message);
              console.error(e);
            }
            
          });
        }
       }
      else { // Invalid file format
        this.alert.error('File format is invalid')
        this.loading = false;
      }
    }
    
  }

  update(value: any, url: any,type :string) {
    const requestBody = value;
    let request: Request = {
      url: url, 
      method: HttpMethod.PUT,
      requestBody
    };
    return this.restService.call(request).pipe(
      tap((record) => {this.printUpdateLog(record, type)}), 
      catchError(err => {this.printUpdateFailedLog(value, err,type);
        console.log(err);
        return of(Observable)}))
  }

  create(value: any, url: any,type :string) {
    const requestBody = value;
    let request: Request = {
      url: url, 
      method: HttpMethod.POST,
      requestBody
    };
    return this.restService.call(request).pipe(
      tap((record) => {this.printCreatedLog(record, type)}), 
      catchError(err => {this.printCreatedFailedLog(value, err, type);
        console.log(err);
        return of(Observable)})) 
  }

  printUpdateLog(record: any,type :string){
    let userName ='';
    if(type == 'users'){
      userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")" 
      this.updatedUsers++;
    }else if(type == 'integration-profiles'){
      userName = record.code + " - " + record.name + " (" + record.type.value + ")" ;
      this.updatedIP++;
    }
    this.updateLogText += userName + ": Updated successfully\n";
  }

  printCreatedLog(record: any,type :string){
    let userName ='';
    if(type == 'users'){
      userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
      this.createdUsers++;
    }else if(type == 'integration-profiles'){
      userName = record.code + " - " + record.name + " (" + record.type.value + ")" 
      this.createdIP++;
    }
    this.updateLogText += userName + ": Created successfully\n";
  }

  printUpdateFailedLog(record:any, error:any, type:string){
    let userName ='';
    if(type == 'users'){
      userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
      this.failedUsers++;
    }else if(type == 'integration-profiles'){
      userName = record.code + " " + record.name + " (" + record.type.value + ")" 
      this.failedIP++;
    }
    this.updateLogText += userName + ": Failed to update - " + error.message + "\n";
  }

  printCreatedFailedLog(record:any, error:any, type:string){
    let userName ='';
    if(type == 'users'){
      userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
      this.failedUsers++;
    }else if(type == 'integration-profiles'){
      userName = record.code + " " + record.name + " (" + record.type.value + ")" 
      this.failedIP++;
    }
    this.updateLogText += userName + ": Failed to create - " + error.message + "\n";
  }

  printAlertMessage(){
    let users_updated = 'Users Updated: '+ this.updatedUsers;
    let users_created = 'Users Created: ' + this.createdUsers;
    let users_failed = 'Users Failed: ' + this.failedUsers;

    this.alert.success(users_updated, { delay: 20000 })
    this.alert.success(users_created, { delay: 20000 })
    if (this.failedUsers !== 0) {
      this.alert.error(users_failed)
    }    
    this.failedUsers = 0;
    this.updatedUsers = 0;
    this.createdUsers = 0;
    this.loading=false;
  }

  printIPAlertMessage(){
    let users_updated = 'Integration profiles Updated: '+ this.updatedIP;
    let users_created = 'Integration profiles Created: ' + this.createdIP;
    let users_failed = 'Integration profiles Failed: ' + this.failedIP;

    this.alert.success(users_updated, { delay: 20000 })
    this.alert.success(users_created, { delay: 20000 })
    if (this.failedIP !== 0) {
      this.alert.error(users_failed)
    }    
    this.failedIP = 0;
    this.updatedIP = 0;
    this.createdIP = 0;
    this.loading=false;
  }
  
  private tryParseJson(value: any) {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(e);
    }
    return undefined;
  }

  private checkOnLoad(){
    
    if (this.selectEntitiesComponent){
      let numberOfitems = this.selectEntitiesComponent.items.length;
      let numberOfChecked = 0
      for (let item of this.selectedEntities.users){
        this.selectEntitiesComponent.items.forEach(value =>{
          if (value.value.id == item.id){
            value.checked = true
            numberOfChecked++;
          }
        })         
      }
      if (numberOfChecked == numberOfitems){
          this.selectEntitiesComponent.masterChecked = true;
          this.selectEntitiesComponent.masterIndeterminate = false;
      }
      else if (numberOfChecked < numberOfitems && numberOfChecked != 0){
        this.selectEntitiesComponent.masterIndeterminate = true;
        this.selectEntitiesComponent.masterChecked = false;
      }
    }  
  }

  removeUser(entity: Entity){
    this.selectedEntities.users = this.selectedEntities.users.filter(item => {return item.id !== entity.id})
    this.storeService.set("Users", this.selectedEntities.users).subscribe(response=>{console.log('Saved');}, 
      error => console.log('Failed to save entitiy: ' + error.message))
    for (let item of this.selectEntitiesComponent.items){
      if (item.value.id == entity.id){
         item.checked = false;
         break
      } 
    }
    let numberOfitems = this.selectEntitiesComponent.items.length;
    let numberOfChecked = 0;
    this.selectEntitiesComponent.items.forEach(value =>{
      if (value.checked){
        numberOfChecked++;
      }
    })
    if (numberOfChecked == 0){
      this.selectEntitiesComponent.masterIndeterminate = false;
      this.selectEntitiesComponent.masterChecked = false;
    }
    else if (numberOfChecked < numberOfitems){
      this.selectEntitiesComponent.masterIndeterminate = true;
      this.selectEntitiesComponent.masterChecked = false;
    }    
  }

  private sendUpdateRequest( url: string, requestBody: any,mappingName : String ) {
    let request: Request = {
      url,
      method: HttpMethod.PUT,
      requestBody
    };
    console.log('Sending API PUT request ' + url );
    this.restService.call(request).subscribe({
      next: result => {
        this.updateLogText = result['row'].length + " " + mappingName+": Saved successfully\n" +this.updateLogText;
        this.alert.success('Allowed ' + mappingName +' saved: ' + result['row'].length, { delay: 20000 })
      },
      error: (e) => {
        this.alert.error('Failed to save Allowed '+mappingName+': ' + e.message);
        console.error(e);
      }
      
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.hasOwnProperty('selectEntitiesComponent') ) {
        this.selectEntitiesComponent.selected = this.selectedEntities.users
    }
  }
}